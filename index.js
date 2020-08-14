const fs = require('fs');
const readline = require('readline');
const {google} = require('googleapis');
const puppeteer = require('puppeteer');
const credentials2 = require('./config');

// If modifying these scopes, delete token.json.
const SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'];
// The file token.json stores the user's access and refresh tokens, and is
// created automatically when the authorization flow completes for the first
// time.
const TOKEN_PATH = 'token.json';

// Load client secrets from a local file.
fs.readFile('credentials.json', (err, content) => {
  if (err) return console.log('Error loading client secret file:', err);
  // Authorize a client with credentials, then call the Gmail API.
  authorize(JSON.parse(content), getBadNewsMessages);
});

/**
 * Create an OAuth2 client with the given credentials, and then execute the
 * given callback function.
 * @param {Object} credentials The authorization client credentials.
 * @param {function} callback The callback to call with the authorized client.
 */
function authorize(credentials, callback) {
  const {client_secret, client_id, redirect_uris} = credentials.installed;
  const oAuth2Client = new google.auth.OAuth2(
      client_id, client_secret, redirect_uris[0]);

  // Check if we have previously stored a token.
  fs.readFile(TOKEN_PATH, (err, token) => {
    if (err) return getNewToken(oAuth2Client, callback);
    oAuth2Client.setCredentials(JSON.parse(token));
    callback(oAuth2Client);
  });
}

/**
 * Get and store new token after prompting for user authorization, and then
 * execute the given callback with the authorized OAuth2 client.
 * @param {google.auth.OAuth2} oAuth2Client The OAuth2 client to get token for.
 * @param {getEventsCallback} callback The callback for the authorized client.
 */
function getNewToken(oAuth2Client, callback) {
  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
  });
  console.log('Authorize this app by visiting this url:', authUrl);
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  rl.question('Enter the code from that page here: ', (code) => {
    rl.close();
    oAuth2Client.getToken(code, (err, token) => {
      if (err) return console.error('Error retrieving access token', err);
      oAuth2Client.setCredentials(token);
      // Store the token to disk for later program executions
      fs.writeFile(TOKEN_PATH, JSON.stringify(token), (err) => {
        if (err) return console.error(err);
        console.log('Token stored to', TOKEN_PATH);
      });
      callback(oAuth2Client);
    });
  });
}

/**
 * Get Bad News Messages
 *
 * @param {google.auth.OAuth2} auth An authorized OAuth2 client.
 */
let orderArray = [];

async function getBadNewsMessages(auth) {
  const gmail = google.gmail({version: 'v1', auth});

    const messageIds = await gmail.users.messages.list({
        userId: 'me',
        q: "bad news",
        labelIds: ['UNREAD']
    });

    console.log(messageIds.data.messages);

    Promise.all(
    messageIds.data.messages.map(async (message) => {
      const orderid = await gmail.users.messages.get({
        userId: 'me',
        id: message.id
      })
      console.log(orderid.data.snippet.slice(173, 189))
      const orderId = orderid.data.snippet.slice(173, 189);
      orderArray.push({orderId: orderId, messageId: message.id});
    })
    ).then(responses => {
        console.log(orderArray);
      })

}

/**
 * Puppeteer
 *
 * 
 */
fs.readFile('config.json', (err, config) => {
  let credentials = JSON.parse(config);
  if (err) return console.log('Error loading client secret file:', err);
  // Authorize a client with credentials, then launch aliexpress.com
  //aliSignIn(credentials)
});

const aliSignIn = async (credentials) => {
  // Create Browser with args
  const browser = await puppeteer.launch({ 
    headless: false,
    slowMo: 150,
    args: ['--disable-notifications']
  });

  // Open a new page and navigate to google.com
  const page = await browser.newPage();
  await page.goto('https://aliexpress.com');

  await new Promise(resolve => setTimeout(resolve, 5000));
  await page.click('.close-layer');

  await new Promise(resolve => setTimeout(resolve, 5000));
  await page.click('.register-btn a');
  console.log('enter');
  await new Promise(resolve => setTimeout(resolve, 5000));

  const loginIframeElement = await page.$('iframe[id="alibaba-login-box"]');
  const loginIframeContent = await loginIframeElement.contentFrame();
  await loginIframeContent.type('#fm-login-id', credentials.username, { delay: 100 });
  await loginIframeContent.type('#fm-login-password', credentials.password, { delay: 100 });
  await new Promise(resolve => setTimeout(resolve, 1000));
  await page.keyboard.press('Enter');

  const [response] = await Promise.all([
    page.waitForNavigation(), // The promise resolves after navigation has finished
  ]);

  // Close the browser and exit the script
  // await browser.close();
};

