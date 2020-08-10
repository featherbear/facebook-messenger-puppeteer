const puppeteer = require('puppeteer')
const atob = require('atob')
const queue = require('queue')

module.exports = class {
  constructor (options) {
    this.options = options || {
      session: null,
      selfListen: false
    }
    this.browser = null
    this.page = null
    this._listenFns = null // begin as null, change to []
    this._aliasMap = {}
    this.uid = null // string

    this._messageQueue = queue({
      autostart: true,
      concurrency: 1,
      timeout: 1000
    })
  }

  async getSession () {
    return this.page.cookies()
  }

  async login (email, password) {
    console.log('Logging in...')
    const browser = (this.browser = await puppeteer.launch({
      headless: !process.env.DEBUG
    }))
    const page = (this.page = (await browser.pages())[0]) // await browser.newPage())

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
    emailField = await page.$('[name=email]')
    passwordField = await page.$('[name=pass]')
    submitButton = await page.$('#loginbutton')

    if (emailField || passwordField || submitButton) {
      throw new Error('Bad credentials')
    }

    this.uid = (await this.getSession()).find(
      cookie => cookie.name === 'c_user'
    ).value

    console.log(`Logged in as ${this.uid}`)
  }

  async _setTarget (target) {
    target = target.toString()

    const threadPrefix = 'https://www.messenger.com/t/'
    let slug = this.page.url().substr(threadPrefix.length)

    if (target === slug || target === this._aliasMap[slug]) {
      return null
    }

    const response = await this.page.goto(`${threadPrefix}${target}`, {
      waitUntil: 'networkidle2'
    })

    slug = this.page.url().substr(threadPrefix.length)
    this._aliasMap[slug] = target

    return response
  }

  async sendMessage (target, data) {
    if (typeof data === 'number') {
      data = data.toString()
    } else if (typeof data === 'function') {
      data = await data()
    }

    await this._setTarget(target)
    const inputElem = await this.page.$('[aria-label^="Type a message"]')

    for (const char of data) {
      if (char === '\n') {
        await this.page.keyboard.down('Shift')
        await this.page.keyboard.press('Enter')
        await this.page.keyboard.up('Shift')
        continue
      }
      await inputElem.type(char)
    }
    await this.page.keyboard.press('Enter')
  }

  _stopListen (optionalCallback) {
    const client = this.page._client

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
        body: json.body,
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

      this.page._client.on(
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
                  this._messageQueue.push(async cb => {
                    await callback(delta)
                    cb()
                  })
                }
              }
            } catch (e) {
              // * cries silently *
              //   console.log(atob(payloadData.substr(16)))
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
    await this._setTarget(groupTarget)
    const uploadBtn = await this.page.$(
      'input[type=file][aria-label="Change Group Photo"]'
    )
    await uploadBtn.uploadFile(imagePath)
  }

  async changeGroupName (groupTarget, name) {
    await this._setTarget(groupTarget)
    const nameElem = await this.page.$('[role=textbox] div div div')
    await nameElem.click()
    await nameElem.type(name)
    await this.page.keyboard.press('Enter')
  }

  async sendFile (target, filePathOrFilePaths) {
    return this.sendImage(target, filePathOrFilePaths)
  }

  async sendImage (target, imagePathOrImagePaths) {
    await this._setTarget(target)

    if (!imagePathOrImagePaths) return

    const images = Array.isArray(imagePathOrImagePaths)
      ? imagePathOrImagePaths
      : Array(imagePathOrImagePaths)
    const uploadBtn = await this.page.$('input[type=file][title="Add Files"]')

    for (const imagePath of images) {
      await uploadBtn.uploadFile(imagePath)
    }

    await this.page.keyboard.press('Enter')
  }
}

// leave site force yes

/*
So either i drop the previous request
or i make it a queue
and finish one at a time
or i could make it scale and do multiple
*/
