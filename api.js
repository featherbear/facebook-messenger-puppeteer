const puppeteer = require('puppeteer')
const atob = require('atob')
const Queue = require('queue')
const mqttParser = require('mqtt-packet').parser
const Order = Symbol('Order')

module.exports = class {
  constructor (options) {
    this.options = {
      session: null,
      selfListen: false,
      workerLimit: 3,
      debug: false,
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
    this.options.debug && console.debug('Received function ', fn, thread)
    if (!thread) throw new Error('No thread target')
    thread = thread.toString()

    let _resolve
    const promise = new Promise(resolve => {
      _resolve = resolve
    })

    const pushQueue = (workerObj, fn) => {
      this.options.debug &&
        console.debug('Pushing function to worker thread', workerObj.id)

      workerObj.queue.push(async finish => {
        this.options.debug && console.debug('Executing function (finally)')
        workerObj.active = true
        workerObj.lastActivity = new Date()
        _resolve(await fn.apply(workerObj.page))
        finish()
      })
    }

    const replaceWorker = async (workerObj, newThread, hookFn) => {
      this.options.debug &&
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
      this.options.debug &&
        console.debug('Existing worker thread found, pushing')
      // Push new action to target worker queue
      pushQueue(target, fn)
    } else {
      this.options.debug && console.debug('Target worker thread not found')
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
          this.options.debug && console.debug('Reached worker thread capacity')
          if (thread in this._actionQueueOutgoing) {
            this.options.debug &&
              console.debug('Adding function to existing queue')
            this._actionQueueOutgoing[thread].push(fn)
          } else {
            this.options.debug && console.debug('Creating new function queue')
            this._actionQueueOutgoing[thread] = [fn]
            this._actionQueueOutgoing[Order].push(thread)
          }
        }
      } else {
        this.options.debug && console.debug('Spawning new worker')
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
          this.options.debug && console.debug('Worker finished tasks')
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
    return new Promise(async (resolve, reject) => {
      this.options.debug && console.log('Logging in...')

      const browser = (this._browser = await puppeteer.launch({
        headless: !this.options.debug
      }))
      const page = (this._masterPage = (await browser.pages())[0]) // await browser.newPage())

      if (this.options.session) {
        await page.setCookie(...this.options.session)
      }

      // await page.setUserAgent("Mozilla/5.0 (Android 7.0; Mobile; rv:54.0) Gecko/54.0 Firefox/54.0")

      // Go to the login page
      await page.goto('https://m.facebook.com/login.php', {
        waitUntil: 'networkidle2'
      })

      // If there's a session (from cookie), then skip login
      let authFail = false
      if (page.url().startsWith('https://m.facebook.com/login.php')) {
        await (async (cb, ...items) =>
          Promise.all(items.map(q => page.$(q))).then(r => cb(...r)))(
          async (emailField, passwordField, submitButton) => {
            // Looks like we're unauthenticated
            await emailField.type(email)
            await passwordField.type(password)
            let navigationPromise = page.waitForNavigation()
            page.$eval('button[name=login]', elem => elem.click())

            setTimeout(async () => {
              if (
                page.url().startsWith('https://m.facebook.com/login.php') &&
                (await Promise.all(
                  [
                    '//div[contains(text(), "find account")]',
                    '//div[contains(text(), "Need help with finding your account?")]',
                    '//div[contains(text(), "The password that you entered is incorrect")]',
                    '//div[contains(text(), "Incorrect password")]'
                  ].map(xPath => page.$x(xPath))
                ).then(r => r.flat().length > 0))
              ) {
                authFail = true
                await this.close()
                reject(new Error('Bad credentials'))
              }
            }, 3000)

            await navigationPromise.catch(() => {})
          },
          'input[name=email]',
          'input[name=pass]',
          'button[name=login]'
        )
      }

      if (!authFail) {
        await page.goto('https://m.facebook.com/messages', {
          waitUntil: 'networkidle2'
        })

        // String
        this.uid = (await this.getSession()).find(
          cookie => cookie.name === 'c_user'
        ).value

        this.options.debug && console.log(`Logged in as ${this.uid}`)
        resolve(this)
      }
    })
  }

  getCurrentUserID () {
    /* String */
    return this.uid
  }

  async _setTarget (page, target) {
    target = target.toString()

    const threadPrefix = 'https://m.facebook.com/messages/read/?tid='
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
      const inputElem = await this.$('[placeholder="Write a message..."]')

      await inputElem.type(data)
      await this.$eval('button[name=send]', elem => elem.click())
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
    // Massage -> Maybe have a proxy so we don't assemble the data for every listener
    return this.listenRaw(async json => {
      const data = {
        body: json.body || '',
        thread: Number(Object.values(json.messageMetadata.threadKey)[0]),
        sender: Number(json.messageMetadata.actorFbId),
        timestamp: json.messageMetadata.timestamp,
        messageId: json.messageMetadata.messageId,
        attachments: json.attachments
      }

      data.type = json.type
      await callback(data)
    })
  }

  listenRaw (callback) {
    // Should probably move this parsing to the above...
    if (this._listenFns === null) {
      this._listenFns = []

      let parser = mqttParser({ protocolVersion: 4 })

      parser.on('packet', ({ topic, payload }) => {
        if (topic !== '/t_ms') return

        let json = JSON.parse(payload)
        if (!json.deltas) return

        for (const delta of json.deltas) {
          switch (delta.class) {
            case 'DeliveryReceipt':
            case 'ReadReceipt':
            case 'MarkFolderSeen':
            case 'NoOp':
              continue

            case 'AdminTextMessage':
              // Theme, emoji, nickname
              // TODO: Group add remove?
              // .type: string
              // .untypedData: any
              // .messageMetadata: any
              // ignore if type === 'change_thread_theme
              continue

            case 'MessageDelete':
              /*
                {
                  actorFbId: '...',
                  attachments: [],
                  irisSeqId: '...',
                  messageIds: [ 'mid.....' ],
                  requestContext: { apiArgs: {} },
                  threadKey: { otherUserFbId: '...' },
                  class: 'MessageDelete'
                }
              */
              // Remove for you
              continue

            case 'NewMessage':
              if (
                delta.messageMetadata.actorFbId === this.uid &&
                !this.options.selfListen
              ) {
                continue
              }
              delta.type = 'message'
              break

            case 'ClientPayload':
              let clientPayload = JSON.parse(
                Buffer.from(delta.payload).toString()
              )
              // FIXME: DEBUG ONLY
              if (
                Object.keys(clientPayload).filter(v => v != 'deltas').length > 0
              ) {
                this.options.debug &&
                  console.debug(
                    'Extra keys',
                    Object.keys(clientPayload),
                    'Extra keys'
                  )
              }

              if (clientPayload.deltas && clientPayload.deltas.length > 1) {
                this.options.debug &&
                  console.debug(
                    'Several deltas',
                    clientPayload.deltas,
                    'Several deltas'
                  )
              }
              // END ME FIXME: IDK HELP

              // { deltas: [ { deltaMessageReply: [Object] } ] }
              // { deltas: [ { deltaMessageReaction: [Object] } ] }
              // { deltas: [ { deltaUpdateThreadTheme: [Object] } ] }
              // { deltas: [ { deltaRecallMessageData: [Object] } ] }

              this.options.debug &&
                console.log('PL', clientPayload.deltas[0], 'PL')
              continue

            default:
              this.options.debug &&
                console.log(delta.class, delta, delta.class, '\n')
              continue
          }

          for (const callback of this._listenFns) {
            this._messageQueueIncoming.push(async finish => {
              await callback(delta)
              finish()
            })
          }
        }
      })

      this._masterPage._client.on(
        'Network.webSocketFrameReceived',
        async ({ timestamp, response: { payloadData } }) => {
          // FIXME: Only parse if longer than ???
          payloadData.length > 8 &&
            parser.parse(Buffer.from(payloadData, 'base64'))
        }
      )
    }

    if (this._listenFns.indexOf(callback) === -1) {
      this._listenFns.push(callback)
    }

    return () => this._stopListen(callback)
  }

  async sendImage (target, imagePathOrImagePaths) {
    if (!imagePathOrImagePaths) return

    const images = Array.isArray(imagePathOrImagePaths)
      ? imagePathOrImagePaths
      : Array(imagePathOrImagePaths)

    return this._delegate(target, async function () {
      for (const imagePath of images) {
        let uploadBtn = await this.$(
          'input[type=file][data-sigil="m-raw-file-input"]'
        )
        await uploadBtn.uploadFile(imagePath)
      }

      await this.waitForSelector('button[name=send]:not([disabled])')
      await this.$eval('button[name=send]', elem => elem.click())
    })
  }

  async close () {
    return this._browser.close()
  }
}
