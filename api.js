const puppeteer = require('puppeteer')
const atob = require('atob')

module.exports = class {
  constructor () {
    this.browser = null
    this.page = null
    this._listenFns = {}
  }

  async getSession () {
    return this.page.cookies()
  }

  async login ({ email, password, session }) {
    const browser = (this.browser = await puppeteer.launch({ headless: false }))
    const page = (this.page = await browser.newPage())

    if (session) {
      await page.setCookie(...session)
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

    emailField = await page.$('[name=email]')
    passwordField = await page.$('[name=pass]')
    submitButton = await page.$('#loginbutton')

    if (emailField || passwordField || submitButton) {
      throw new Error('Bad credentials')
    }
  }

  async _setTarget (target) {
    const targetURL = `https://www.messenger.com/t/${target}`
    if (this.page.url() != targetURL) {
      return this.page.goto(targetURL, { waitUntil: 'networkidle2' })
    }
    return null
  }

  async sendMessage (target, data) {
    if (typeof data === 'number') {
      data = data.toString()
    } else if (typeof data === 'function') {
      data = await data()
    }

    await this._setTarget(target)
    const inputElem = await this.page.$('[aria-label="Type a message..."]')

    await inputElem.type(data)
    await this.page.keyboard.press('Enter')
  }

  stopListen (optionalCallback) {
    const client = this.page._client

    if (typeof optionalCallback === 'function') {
      client.off('Network.webSocketFrameReceived', this._listenFns[optionalCallback])
      delete this._listenFns[optionalCallback]
    } else {
      for (const fn of Object.values(this._listenFns)) {
        client.off('Network.webSocketFrameReceived', fn)
      }
      this._listenFns = {}
    }
  }

  listen (callback) {
    if (!(callback in this._listenFns)) {
      const fn = ({ timestamp, response: { payloadData } }) => {
        if (payloadData.length > 16) {
          try {
            // :shrug:
            const json = JSON.parse(atob(payloadData.substr(16)))

            // Develop
            if (json.deltas.length > 1) {
              console.warn('More than one delta!')
            }

            for (const delta of json.deltas) {
              callback(delta)
            }
          } catch (e) {
            // * cries silently *
            //   console.log(atob(payloadData.substr(16)))
          }
        }
      }

      this.page._client.on('Network.webSocketFrameReceived', fn)
      this._listenFns[callback] = fn
    }

    return () => this.stopListen(callback)
  }
}
