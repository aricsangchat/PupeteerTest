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

// Get GmailCredentials
const getGmailCreds = (resolve) => {
  fs.readFile('gmailCredentials.json', (err, data) => {
    if (err) return console.log('Error loading gmail credentials.json:', err);
    gmailCredentials = JSON.parse(data);
    return resolve();
  });
}

// Get AliCredentials
const getAliCreds = (resolve) => {
  fs.readFile('otherCredentials.json', (err, data) => {
    if (err) return console.log('Error loading otherCredentials.json:', err);
    aliCredentials = JSON.parse(data).ali;
    return resolve();
  });
}

/**
 * Create an OAuth2 client with the given credentials, and then execute the
 * given callback function.
 * @param {Object} credentials The authorization client credentials.
 * @param {function} callback The callback to call with the authorized client.
 */
const authorize = (credentials, callback) => {
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
const getNewToken = (oAuth2Client, callback) => {
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

//Check Gmail for Bad News Messages
const checkEmail = async (resolve) => {
  authorize(gmailCredentials, 
    async (auth) => {
      const gmail = google.gmail({version: 'v1', auth});
  
      const messageIds = await gmail.users.messages.list({
          userId: 'me',
          q: "bad news",
          labelIds: ['UNREAD']
      });
  
      console.log(messageIds.data.messages);

      for (let index = 0; index < messageIds.data.messages.length; index++) {
        let message = await gmail.users.messages.get({
          userId: 'me',
          id: messageIds.data.messages[index].id
        });
        console.log(message.data.snippet);
        let orderId = message.data.snippet.slice(173, 189);
        orderArray.push({orderId: orderId, messageId: messageIds.data.messages[index].id});
      }

      console.log(orderArray);
      return resolve();
    }
  )
}

// Opens AliExpress and checks to see if order was delivered
const checkDelivery = async (resolve) => {
  page = await browser.newPage();
  
  for (order of orderArray) {  
    await Promise.all([
      page.waitForNavigation(),
      page.goto(`${orderDetailUrl}${order.orderId}`)
    ])
    // Check Tracking status to confirm delivery
    let trackingStatus = '';
    try {
      await page.waitForSelector('#logistic-item1 > td.detail > div.list-box > ul:nth-child(1) > li:nth-child(1)', {
        timeout: 5000
      })
      trackingStatus = await page.evaluate(() => document.querySelector('#logistic-item1 > td.detail > div.list-box > ul:nth-child(1) > li:nth-child(1)').innerText);
    } catch (e) {
      if (e instanceof puppeteer.errors.TimeoutError) {
        undeliveredOrders.push(order);
      }
    }
    // Handle If logic for delivery status
    if (trackingStatus.includes('Delivery')) {
      deliveredOrders.push({
        orderId: order.orderId, 
        messageId: order.messageId,
        Status: trackingStatus
      });
    } else {
      // Handle non delivery
      // Check to see if disipute is open
      let disputeStatus = '';
      try {
        await page.waitForSelector('#item164732391999956 > td.trade-status > a', {
          timeout: 5000
        })
        disputeStatus = await page.evaluate(() => document.querySelector('#item164732391999956 > td.trade-status > a').innerText);
        
      } catch (e) {
        if (e instanceof puppeteer.errors.TimeoutError) {
          console.log(e);
        }
      }
      
      if (disputeStatus == 'Open Dispute') {
        undeliveredOrders.push({
          orderId: order.orderId, 
          messageId: order.messageId,
          disputeStatus: false
         });
      } else {
        undeliveredOrders.push({
          orderId: order.orderId, 
          messageId: order.messageId,
          disputeStatus: true
         });
      }
    }
  }
  return resolve();
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
      console.log('dispute text',innerText);
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

// Save File Function
const saveFile = (resolve, data, fileName) => {
  const obj = {
    batchTimeStamp: Date.now(),
    data: data
  };

  const json = JSON.stringify(obj);
  fs.writeFile(fileName, json, 'utf8', () => {
    return resolve();
  });
}

// Marks bad news emails as read
const markEmailAsRead = (resolve) => {
  let mailIds = [];
  orderArray.map(message => {
    mailIds.push(message.messageId);
  });
  authorize(gmailCredentials, async (auth) => {
    const gmail = google.gmail({version: 'v1', auth});
    await gmail.users.messages.batchModify({
      userId: 'me',
      requestBody: {
        ids: mailIds,
        removeLabelIds: 'UNREAD'
      }
    });

    return resolve();
  })

}

// Login to AliExpress
const loginAliExpress = async (resolve) => {
  aliPage = await browser.newPage();
  // Sign In
  await aliPage.goto('https://aliexpress.com');
  // Wait 5 Seconds
  await new Promise(resolve => setTimeout(resolve, 5000));
  // Close Popup
  try {
      await aliPage.click('.close-layer');
  } catch (e) {
      if (e instanceof puppeteer.errors.TimeoutError) {
          // Do something if this is a timeout.
          console.log(e);
      }
  }

  let signInText = await aliPage.evaluate(() => document.querySelector('.flyout-welcome-text').innerText);
  console.log(signInText);
  if (signInText == 'Welcome to AliExpress.com') {
      // Wait 5 Seconds
      await new Promise(resolve => setTimeout(resolve, 5000));
      // Click Sign In Button
      await aliPage.click('.register-btn a');
      // Wait 5 Seconds
      await new Promise(resolve => setTimeout(resolve, 8000));
      // Select Login Form from within Iframe
      const loginIframeElement = await aliPage.$('iframe[id="alibaba-login-box"]');
      const loginIframeContent = await loginIframeElement.contentFrame();
      // Fill in Username
      await loginIframeContent.evaluate(() => {
        document.querySelector('#fm-login-id').value = '';
      });
      await loginIframeContent.type('#fm-login-id', aliCredentials.username, { delay: 100 });
      // Fill in Password
      await loginIframeContent.type('#fm-login-password', aliCredentials.password, { delay: 100 });
      // Wait 1 second
      await new Promise(resolve => setTimeout(resolve, 1000));
      // Keypress Enter
      await aliPage.keyboard.press('Enter');
      await new Promise(resolve => setTimeout(resolve, 5000));
      await aliPage.close();
      return resolve();
  } else {
      // Already signed in
      await new Promise(resolve => setTimeout(resolve, 5000));
      await aliPage.close();
      return resolve();
  }
}

// One function to Rule them all
const initializeWorkFlow = async () => {
  browser = await puppeteer.launch({ 
    headless: false,
    slowMo: 150,
    args: [
        '--disable-notifications',
        '--disable-extensions-except=../../../../../../AliAddressAutoFill/extension',
        '--load-extension=../../AliAddressAutoFill/extension/',
    ],
    defaultViewport: null,
    userDataDir: "./user_data"
  });
  // Get gmail creds
  await new Promise(resolve => getGmailCreds(resolve));
  // Get ali creds
  await new Promise(resolve => getAliCreds(resolve));
  // Check Email for Bad News Messages
  await new Promise(resolve => checkEmail(resolve));
  // Login to AliExpress
  await new Promise(resolve => loginAliExpress(resolve));
  // Wait
  await new Promise(resolve => setTimeout(resolve, 1000));
  // Check AliExpress to see if orders have been delivered
  await new Promise(resolve => checkDelivery(resolve));
  // Save delivered and undelivered data in files for later use
  await new Promise(resolve => saveFile(resolve, undeliveredOrders, 'undelivered.json'));
  await new Promise(resolve => saveFile(resolve, deliveredOrders, 'delivered.json'));
  // Mark emails as read
  await new Promise(resolve => markEmailAsRead(resolve));
  // Finish
  console.log('done');
  //openDisputes();
  
}
initializeWorkFlow();