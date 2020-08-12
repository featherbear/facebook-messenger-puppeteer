const puppeteer = require('puppeteer')
const atob = require('atob')
const Queue = require('queue')

const Order = Symbol('Order')

module.exports = class {
  constructor (options) {
    this.options = {
      session: null,
      selfListen: false,
      workerLimit: 3,
      ...(options || {})
    }
    this._browser = null // Puppeteer instance
    this._masterPage = null // Holds the master page
    this._workerPages = [] // Holds the worker pages

    this._listenFns = null // Begin as null, changes to [] when primed

    this._aliasMap = {} // Maps user handles to IDs

    this.uid = null // Holds the user's ID when authenticated

    // Handle new messages sequentially
    this._messageQueueIncoming = Queue({
      autostart: true,
      concurrency: 1,
      timeout: 1000
    })

    // Worker thread queue
    this._actionQueueOutgoing = {
      [Order]: []
    }
  }

  threadHandleToID (handle) {
    // FIXME: Should this be ID to Handle???
    // Received messages contain the ID
    // Outgoing messages get changed to the handle
    // But if a user changes their username, the cache will be wrong
    return this._aliasMap[handle] || handle
  }

  async _delegate (thread, fn) {
    console.debug('Received function ', fn, thread)
    if (!thread) throw new Error('No thread target')
    thread = thread.toString()

    let _resolve
    const promise = new Promise(resolve => {
      _resolve = resolve
    })

    const pushQueue = (workerObj, fn) => {
      console.debug('Pushing function to worker thread', workerObj.id)

      workerObj.queue.push(async finish => {
        console.debug('Executing function (finally)')
        workerObj.active = true
        workerObj.lastActivity = new Date()
        _resolve(await fn.apply(workerObj.page))
        finish()
      })
    }

    const replaceWorker = async (workerObj, newThread, hookFn) => {
      console.debug('Replacing worker thread queue', workerObj.id)
      workerObj.thread = null
      workerObj.queue.autostart = false

      hookFn && (await hookFn())

      await this._setTarget(workerObj.page, newThread)
      workerObj.thread = newThread
      workerObj.queue.start()
      workerObj.queue.autostart = true
    }

    const target = this._workerPages.find(
      workerObj => this.threadHandleToID(thread) === workerObj.thread
    )

    if (target) {
      console.debug('Existing worker thread found, pushing')
      // Push new action to target worker queue
      pushQueue(target, fn)
    } else {
      console.debug('Target worker thread not found')
      // Queue new action if there are no free workers
      if (this._workerPages.length >= this.options.workerLimit) {
        const freeTarget = this._workerPages
          .filter(workerObj => !workerObj.active)
          .sort((a, b) => a.lastActivity > b.lastActivity)
          .shift()
        if (freeTarget) {
          replaceWorker(freeTarget, thread, async () =>
            pushQueue(freeTarget, fn)
          )
        } else {
          console.debug('Reached worker thread capacity')
          if (thread in this._actionQueueOutgoing) {
            console.debug('Adding function to existing queue')
            this._actionQueueOutgoing[thread].push(fn)
          } else {
            console.debug('Creating new function queue')
            this._actionQueueOutgoing[thread] = [fn]
            this._actionQueueOutgoing[Order].push(thread)
          }
        }
      } else {
        console.debug('Spawning new worker')
        // Create a new worker if there is an empty worker slot
        const target = {
          thread,
          active: true,
          lastActivity: new Date(),
          queue: Queue({
            autostart: false, // Do not start queue until the new page is ready
            concurrency: 1,
            timeout: 2000
          }),
          id: this._workerPages.length
        }
        pushQueue(target, fn)
        this._workerPages.push(target)

        // Attach page
        const page = await this._browser.newPage()
        await this._setTarget(page, thread)
        target.page = page

        // Handle worker replacement
        target.queue.on('end', async () => {
          console.debug('Worker finished tasks')
          target.active = false
          const next = this._actionQueueOutgoing[Order].shift()
          if (!next) return

          await replaceWorker(target, next, async () => {
            const outgoingQueue = this._actionQueueOutgoing[next]
            delete this._actionQueueOutgoing[next]
            outgoingQueue.forEach(fn => pushQueue(target, fn))
          })
        })

        // Enable queue
        target.queue.start()
        target.queue.autostart = true
      }
    }

    return promise
  }

  async getSession () {
    return this._masterPage.cookies()
  }

  async login (email, password) {
    console.log('Logging in...')
    const browser = (this._browser = await puppeteer.launch({
      headless: !process.env.DEBUG
    }))
    const page = (this._masterPage = (await browser.pages())[0]) // await browser.newPage())

    if (this.options.session) {
      await page.setCookie(...this.options.session)
    }

    await page.goto('https://messenger.com', { waitUntil: 'networkidle2' })

    let emailField = await page.$('[name=email]')
    let passwordField = await page.$('[name=pass]')
    let submitButton = await page.$('#loginbutton')

    if (emailField && passwordField && submitButton) {
      // Looks like we're unauthenticated
      await emailField.type(email)
      await passwordField.type(password)

      const navigationPromise = page.waitForNavigation()
      await submitButton.click()
      await navigationPromise
    }

    // Check if we still haven't logged in
    // TODO: Check page.url() for (un)successful login
    emailField = await page.$('[name=email]')
    passwordField = await page.$('[name=pass]')
    submitButton = await page.$('#loginbutton')

    if (emailField || passwordField || submitButton) {
      throw new Error('Bad credentials')
    }

    this.uid = (await this.getSession()).find(
      cookie => cookie.name === 'c_user'
    ).value

    await page.goto(`https://messenger.com/t/${this.uid}`, {
      waitUntil: 'networkidle2'
    })

    // Deny audio and video calls
    page._client.on(
      'Network.webSocketFrameReceived',
      async ({ timestamp, response: { payloadData } }) => {
        if (payloadData.length < 20) return
        try {
          if (
            JSON.parse(atob(payloadData.substr(20))).type === 'rtc_multi_json'
          ) {
            setTimeout(async () => {
              try {
                const cancelBtn = await page.$('[data-testid=ignoreCallButton]')
                await cancelBtn.click()
              } catch {}
            }, 100)
          }
        } catch {}
      }
    )

    console.log(`Logged in as ${this.uid}`)
  }

  async _setTarget (page, target) {
    target = target.toString()

    const threadPrefix = 'https://www.messenger.com/t/'
    let slug = page.url().substr(threadPrefix.length)

    if (target === this.threadHandleToID(slug)) {
      return null
    }

    const response = await page.goto(`${threadPrefix}${target}`, {
      waitUntil: 'networkidle2'
    })

    slug = page.url().substr(threadPrefix.length)
    this._aliasMap[slug] = target

    return response
  }

  async sendMessage (target, data) {
    if (typeof data === 'number') {
      data = data.toString()
    } else if (typeof data === 'function') {
      data = await data()
    }

    this._delegate(target, async function () {
      const inputElem = await this.$('[aria-label^="Type a message"]')

      for (const char of data) {
        if (char === '\n') {
          await this.keyboard.down('Shift')
          await this.keyboard.press('Enter')
          await this.keyboard.up('Shift')
          continue
        }
        await inputElem.type(char)
      }
      await this.keyboard.press('Enter')
    })
  }

  _stopListen (optionalCallback) {
    const client = this._masterPage._client

    if (typeof optionalCallback === 'function') {
      client.off('Network.webSocketFrameReceived', optionalCallback)
      this._listenFns = this._listenFns.filter(
        callback => callback !== optionalCallback
      )
    } else {
      for (const callback of this._listenFns) {
        client.off('Network.webSocketFrameReceived', callback)
      }
      this._listenFns = []
    }
  }

  listen (callback) {
    return this.listenRaw(async json => {
      const data = {
        body: json.body || '',
        thread: Object.values(json.messageMetadata.threadKey)[0],
        sender: json.messageMetadata.actorFbId,
        timestamp: json.messageMetadata.timestamp,
        messageId: json.messageMetadata.messageId,
        attachments: json.attachments
      }

      await callback(data)
    })
  }

  listenRaw (callback) {
    if (this._listenFns === null) {
      this._listenFns = []

      this._masterPage._client.on(
        'Network.webSocketFrameReceived',
        async ({ timestamp, response: { payloadData } }) => {
          if (payloadData.length > 16) {
            try {
              // :shrug:
              const json = JSON.parse(atob(payloadData.substr(16)))

              for (const delta of json.deltas) {
                if (delta.class !== 'NewMessage') continue
                if (
                  delta.messageMetadata.actorFbId === this.uid &&
                  !this.options.selfListen
                ) {
                  continue
                }

                for (const callback of this._listenFns) {
                  this._messageQueueIncoming.push(async finish => {
                    await callback(delta)
                    finish()
                  })
                }
              }
            } catch (e) {
              // * cries silently *
              //   console.debug(atob(payloadData.substr(16)))
            }
          }
        }
      )
    }

    if (this._listenFns.indexOf(callback) === -1) {
      this._listenFns.push(callback)
    }

    return () => this._stopListen(callback)
  }

  async changeGroupPhoto (groupTarget, imagePath) {
    return this._delegate(groupTarget, async function () {
      const uploadBtn = await this.$(
        'input[type=file][aria-label="Change Group Photo"]'
      )
      await uploadBtn.uploadFile(imagePath)
    })
  }

  async changeGroupName (groupTarget, name) {
    return this._delegate(groupTarget, async function () {
      const nameElem = await this.$('[role=textbox] div div div')
      await nameElem.click()
      await nameElem.type(name)
      await this.keyboard.press('Enter')
    })
  }

  async sendFile (target, filePathOrFilePaths) {
    return this.sendImage(target, filePathOrFilePaths)
  }

  async sendImage (target, imagePathOrImagePaths) {
    if (!imagePathOrImagePaths) return

    return this._delegate(target, async function () {
      const images = Array.isArray(imagePathOrImagePaths)
        ? imagePathOrImagePaths
        : Array(imagePathOrImagePaths)
      const uploadBtn = await this.$('input[type=file][title="Add Files"]')

      for (const imagePath of images) {
        await uploadBtn.uploadFile(imagePath)
      }

      await this.keyboard.press('Enter')
    })
  }
}
