# Facebook Messenger Chat API via Puppeteer

Facebook's been getting _real good_ at detecting and blocking accounts that are using (unofficial) user-account chat APIs, for example

* https://github.com/carpedm20/fbchat
* https://github.com/Schmavery/facebook-chat-api
* https://github.com/ChatPlug/libfb-js

It is likely that the reason why these libraries are being detected is because they do not send all the various polling information to Facebook. Some of these microanalytics are probably randomly generated each time too...

Whilst Facebook _does_ have an [official API](https://developers.facebook.com/docs/messenger-platform), it is run on service accounts. Good for most cases, but not for all.

This project aims to create bindings to Messenger from a headless instance of Chrome using `puppeteer`, such that a fully fledged browser will do all of Facebook's microanalytic blunders

# Installation

You can install the library through npm

```
npm install featherbear/facebook-messenger-puppeteer
```

# Usage

```
const Client = require('facebook-messenger-puppeteer')
```

* `Client( {...opts} )`
  * `selfListen` - `bool` - default: `false`
  * `session` - `Array[CookieObj]`
  * `workerLimit` - `int` - default: `3`
* `.getSession()`
* `.getUID()` - `string`
* `.login(email, password)`
* `.sendMessage(target, data)`
* `.listen(callback)`
* `.listenRaw(callback)`
* `.sendImage(target, imagePathOrImagePaths)`

# References

* https://github.com/phucledien/puppeteer-messenger-spammer/blob/master/index.js
* https://stackoverflow.com/questions/48375700/how-to-use-puppeteer-to-dump-websocket-data
* https://github.com/puppeteer/puppeteer/blob/v5.2.1/docs/api.md#browserpages