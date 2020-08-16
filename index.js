const fs = require('fs');
const readline = require('readline');
const {google} = require('googleapis');
const puppeteer = require('puppeteer');
let orderDetailUrl = 'https://trade.aliexpress.com/order_detail.htm?orderId=';
let aliCredentials = {};
let gmailCredentials = null;
let orderArray = [];
let page = null;
let browser = null;
let undeliveredOrders = [];
let deliveredOrders = [];

// Set Gmail Authorization Scopes
const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly', 
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.labels'
];
// Path to Gmail Token
const TOKEN_PATH = 'token.json';

/**
 * Create an OAuth2 client with the given credentials, and then execute the
 * given callback function.
 * @param {Object} credentials The authorization client credentials.
 * @param {function} callback The callback to call with the authorized client.
 */
function authorize(credentials, callback, callback2) {
  const {client_secret, client_id, redirect_uris} = credentials.installed;
  const oAuth2Client = new google.auth.OAuth2(
      client_id, client_secret, redirect_uris[0]);

  // Check if we have previously stored a token.
  fs.readFile(TOKEN_PATH, (err, token) => {
    if (err) return getNewToken(oAuth2Client, callback);
    oAuth2Client.setCredentials(JSON.parse(token));
    callback(oAuth2Client, callback2);
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
 * Get and store Bad News Order Ids in orderArray
 *
 * @param {google.auth.OAuth2} auth An authorized OAuth2 client.
 * @param {function} callback Callback function to run.
 */
async function getBadNewsMessages(auth, callback) {
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
      //console.log(orderid.data.snippet.slice(173, 189))
      const orderId = orderid.data.snippet.slice(173, 189);
      orderArray.push({orderId: orderId, messageId: message.id});
    })
    ).then(responses => {
      callback()
    }).catch(err => {
      console.log('Error getting Bad News Messages:', err);
    });
}

/**
 * Launchs Puppeteer and Signs in to AliExpress.com
 *
 */
const initializeAliExpress = async (callback) => {
  // Creates Browser with args
  browser = await puppeteer.launch({ 
    headless: false,
    slowMo: 150,
    args: ['--disable-notifications'],
    defaultViewport: null
  });

  // Open a new page and navigate to aliexpress.com
  page = await browser.newPage();
  await page.goto('https://aliexpress.com');
  // Wait 5 Seconds
  await new Promise(resolve => setTimeout(resolve, 5000));
  // Close Popup
  try {
    await page.click('.close-layer');
  } catch (e) {
    if (e instanceof puppeteer.errors.TimeoutError) {
      // Do something if this is a timeout.
      console.log(e);
    }
  }
  // Wait 5 Seconds
  await new Promise(resolve => setTimeout(resolve, 5000));
  // Click Sign In Button
  await page.click('.register-btn a');
  // Wait 5 Seconds
  await new Promise(resolve => setTimeout(resolve, 8000));
  // Select Login Form from within Iframe
  const loginIframeElement = await page.$('iframe[id="alibaba-login-box"]');
  const loginIframeContent = await loginIframeElement.contentFrame();
  // Fill in Username
  await loginIframeContent.type('#fm-login-id', aliCredentials.username, { delay: 100 });
  // Fill in Password
  await loginIframeContent.type('#fm-login-password', aliCredentials.password, { delay: 100 });
  // Wait 1 second
  await new Promise(resolve => setTimeout(resolve, 1000));
  // Keypress Enter
  await page.keyboard.press('Enter');
  // Wait login redirect
  await Promise.all([
    page.waitForNavigation(), // The promise resolves after navigation has finished
  ])
  // Run Callback
  callback();
};
// Checks the BadNews orders to see if they have been delivered or not,
// handles logic to seperate delivered and undelivered orders,
// pushes the order ids and message ids to corresponding arrays
const checkBadNewsOrders = async () => {

  for (order of orderArray) {  
    await Promise.all([
      page.goto(`${orderDetailUrl}${order.orderId}`),
      page.waitForNavigation(), // The promise resolves after navigation has finished
    ])
    let innerText = '';
    try {
      await page.waitForSelector('#logistic-item1 > td.detail > div.list-box > ul:nth-child(1) > li:nth-child(1)', {
        timeout: 5000
      })
      innerText = await page.evaluate(() => document.querySelector('#logistic-item1 > td.detail > div.list-box > ul:nth-child(1) > li:nth-child(1)').innerText);
    } catch (e) {
      if (e instanceof puppeteer.errors.TimeoutError) {
        undeliveredOrders.push(order);
      }
    }
    console.log(order.orderId, innerText);
    if (innerText.includes('Delivery')) {
      deliveredOrders.push(order);
    } else {
      undeliveredOrders.push(order);
    }
  }
  console.log(undeliveredOrders);
  saveUndeliveredOrdersFile(undeliveredOrders, markMessagesAsRead);
  saveDeliveredOrdersFile(deliveredOrders);
  //openDisputes();
};
// Work in Progress, will open disputes for undelivered orders
const openDisputes = async () => {
  for (order of undeliveredOrders) {  
    // Go to order detail page
    await Promise.all([
      page.goto(`${orderDetailUrl}${order.orderId}`),
      page.waitForNavigation(), // The promise resolves after navigation has finished
    ])
    // Confirm dispute is not currently open
    let innerText = '';
    try {
      await page.waitForSelector('#item164732391999956 > td.trade-status > a', {
        timeout: 5000
      })
      innerText = await page.evaluate(() => document.querySelector('#item164732391999956 > td.trade-status > a').innerText);
      console.log(innerText);
    } catch (e) {
      if (e instanceof puppeteer.errors.TimeoutError) {
        console.log(e);
      }
    }
    await Promise.all([
      page.click('#item164732391999956 > td.trade-status > a', {
        delay: 200
      }),
      page.waitForNavigation(), // The promise resolves after navigation has finished
    ])
    
  }
}
// Saves undelivered orders to a JSON
const saveUndeliveredOrdersFile = (arr, callback) => {
  const obj = {
    batchTimeStamp: Date.now(),
    orders: arr
  };
  
  const json = JSON.stringify(obj);
  fs.writeFile('undeliveredOrders.json', json, 'utf8', callback);
}
// Saves the delivered orders to a JSON for later use will automate
// to send confirmation message on Etsy
const saveDeliveredOrdersFile = (arr) => {
  const obj = {
    batchTimeStamp: Date.now(),
    orders: arr
  };
  const json = JSON.stringify(obj);
  fs.writeFile('deliveredOrders.json', json, 'utf8', () => console.log('Saved File'));
}
// Marks messages as read after it saves the delivered
// and undelivered files
const markMessagesAsRead = () => {
  let mailIds = [];
  orderArray.map(message => {
    mailIds.push(message.messageId);
  });
  authorize(gmailCredentials, (auth) => {
    const gmail = google.gmail({version: 'v1', auth});
    gmail.users.messages.batchModify({
      userId: 'me',
      requestBody: {
        ids: mailIds,
        removeLabelIds: 'UNREAD'
      }
    });
  })
}
// Main function to start the work flow
async function initializeWorkFlow() {
   // Initialize Gmail Credentials
   const initializeGmail = () => {
    fs.readFile('gmailCredentials.json', (err, data) => {
      if (err) return console.log('Error loading gmail credentials.json:', err);
      gmailCredentials = JSON.parse(data);
      authorize(gmailCredentials, getBadNewsMessages, checkBadNewsOrders);
    });
  } 
  // Initialize Ali Credentials
  fs.readFile('aliCredentials.json', (err, data) => {
    if (err) return console.log('Error loading aliCredentials.json:', err);
    aliCredentials = JSON.parse(data);
    initializeAliExpress(initializeGmail);
  });
}
initializeWorkFlow();