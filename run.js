const fs = require('fs')
const path = require('path')

const Client = require('./api')

const credentials = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8')
)
credentials.session = fs.existsSync(path.join(__dirname, '.appstate.json'))
  ? JSON.parse(fs.readFileSync(path.join(__dirname, '.appstate.json'), 'utf8'))
  : null

const api = new Client()

;(async () => {
  await api.login(credentials.email, credentials.password)

  // Save current cookie
  fs.writeFileSync(
    path.join(__dirname, '.appstate.json'),
    JSON.stringify(await api.getSession())
  )

  api.listen(json => {
    // json.class === 'NewMessage'
    // json.body
    // json.messageMetadata.actorFbId
    // json.messageMetadata.threadKey.threadFbId
    // json.messageMetadata.messageId
    // json.messageMetadata.timestamp

    console.log(json)
  })
})()
