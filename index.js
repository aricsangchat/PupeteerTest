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
let recentlyShippedOrders = [];

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

// Get Ali and Etsy Credentials
const getOtherCreds = (resolve) => {
  fs.readFile('otherCredentials.json', (err, data) => {
    if (err) return console.log('Error loading otherCredentials.json:', err);
    aliCredentials = JSON.parse(data).ali;
    etsyCredentials = JSON.parse(data).etsy;
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

// Check new tracking emails
const checkNewTrackingEmails = (resolve) => {
  authorize(gmailCredentials, 
    async (auth) => {
      const gmail = google.gmail({version: 'v1', auth});
  
      const messageIds = await gmail.users.messages.list({
          userId: 'me',
          q: "it may take up to 24 hours to see tracking information",
          labelIds: ['UNREAD'],
          maxResults: 20
      });
  
      console.log(messageIds.data.messages);

      for (email of messageIds.data.messages) {
        let message = await gmail.users.messages.get({
          userId: 'me',
          id: email.id
        });
        //console.log(message.data.snippet);
        let orderId = message.data.snippet.slice(135, 151);
        //console.log(orderId);
        recentlyShippedOrders.push({
          orderId: orderId,
          messageId: email.id
        })
      }
      console.log(recentlyShippedOrders);
      return resolve();
    }
  )
}

// Get Tracking number from aliexpress
// Opens AliExpress and checks to see if order was delivered
const getTrackingNumber = async (resolve) => {
  page = await browser.newPage();
  
  for (order of recentlyShippedOrders) {  
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
  
      }
    }
    console.log(trackingStatus);

    // Check Tracking #
    let trackingNumber = '';
    let shippingCompany = '';
    let customerName = '';
    let trackingDetails = {};
    try {
      await page.waitForSelector('.logistics-num', {
        timeout: 5000
      })
      trackingNumber = await page.evaluate(() => document.querySelector('.logistics-num').innerText);
      trackingNumber = trackingNumber.replace(/ /g, '');
      shippingCompany = await page.evaluate(() => document.querySelector('.logistics-name').innerText);
      customerName = await page.evaluate(() => document.querySelector('#user-shipping-list > li:nth-child(1) > span').innerText);
      
    } catch (e) {
      if (e instanceof puppeteer.errors.TimeoutError) {
        
      }
    }
    
    trackingDetails = {
      number: trackingNumber,
      shippingCompany: shippingCompany,
      customer: customerName
    }

    if (!trackingStatus.includes('Delivery')) {
      recentlyShippedOrders.map(_order => {
        if (_order.orderId == order.orderId) {
          _order.trackingDetails = trackingDetails
        }
      })
    } else {
      recentlyShippedOrders.map(_order => {
        if (_order.orderId == order.orderId) {
          _order.trackingDetails = trackingStatus;
        }
      })
    }
    
  }
  console.log(recentlyShippedOrders);
  return resolve();
};

// Login to Etsy.com
const loginEtsy = async (resolve) => {
  await Promise.all([
    page.waitForNavigation(),
    page.goto('https://etsy.com')
    
  ]);

  const loggedin = await page.evaluate(() => {
      return document.querySelectorAll('.account-nav').length;
  });

  // Check if logged in
  if (loggedin > 0) {
    // already logged in
    return resolve();
  } else {
    // login
    // Wait
    await new Promise(resolve => setTimeout(resolve, 500));
    // Click on sign in button
    await page.click('#gnav-header-inner > div.wt-flex-shrink-xs-0 > nav > ul > li:nth-child(1) > button', {
        delay: 200
    });
    // Wait for login modal
    try {
        await page.waitForSelector('#join_neu_email_field', {
          timeout: 5000
        })
    } catch (e) {
        if (e instanceof puppeteer.errors.TimeoutError) {
          console.log(e);
        }
    }
    // Enter Email Address
    await page.type('#join_neu_email_field', etsyCredentials.userName, { delay: 100 });
    // Wait
    await new Promise(resolve => setTimeout(resolve, 300));
    // Enter Password
    await page.type('#join_neu_password_field', etsyCredentials.password, { delay: 100 });
    // Wait
    await new Promise(resolve => setTimeout(resolve, 500));
    // Keypress Enter, Wait for page reload,
    // navigate to orders page, wait for page load
    await page.keyboard.press('Enter');

    await Promise.all([
        page.waitForNavigation()
    ]);
    await new Promise(resolve => setTimeout(resolve, 700));
    return resolve();
  }
}

const selectShippingCompany = async (resolve, order) => {
  if (order.trackingDetails.shippingCompany == 'e邮宝' || order.trackingDetails.shippingCompany.includes('AliExpress')) {
    await page.waitForSelector('.col-group > div > .col-md-6 > .select-wrap > .select')
    await page.click('.col-group > div > .col-md-6 > .select-wrap > .select')
    
    await page.select('.col-group > div > .col-md-6 > .select-wrap > .select', '-1')
    
    await page.waitForSelector('.col-group > div > .col-md-6 > .select-wrap > .select')
    await page.click('.col-group > div > .col-md-6 > .select-wrap > .select')
    await new Promise(resolve => setTimeout(resolve, 1500));
    // Enter Shipping company name
    await page.type('.overlay-region > div > div.overlay-body.p-xs-0.height-full.overflow-scroll > div > div:nth-child(2) > div > div.mt-xs-3.mt-md-4.mb-xs-8.mb-md-4.pl-xs-3.pr-xs-3.pb-xs-8.pl-md-5.pr-md-5.pb-md-5.pl-lg-6.pr-lg-6.pb-lg-6 > div.panel.mt-xs-4.mb-xs-0 > div > div > div > div.col-lg-6.col-xl-7.mt-xs-2.mt-md-3.mt-lg-0 > div > div > div.col-md-6.col-lg-12.col-xl-5.pr-xl-0.mb-xs-2.mb-xl-0 > div.mt-xs-2 > input', 'China EMS', {delay: 100});
    await new Promise(resolve => setTimeout(resolve, 500));
    await page.click('.overlay-region > div > div.overlay-footer.clearfix.bt-xs-0.p-xs-0.position-absolute.position-bottom.width-full.z-index-2 > div > div > div > div.flag.hide-xs.hide-sm > div.flag-img.flag-img-right.no-wrap > button.btn.btn-primary.btn-orange');
    return resolve();
  }
}

// Add tracking numbers in Etsy
const addTrackingNumbers = async (resolve) => {
  await Promise.all([
    page.waitForNavigation(),
    page.goto('https://www.etsy.com/your/orders/sold')
    
  ]);

  try {
    await page.waitForSelector('#orders-header-search-input', {
      timeout: 5000
    })
  } catch (e) {
    if (e instanceof puppeteer.errors.TimeoutError) {
    }
  }

  for(order of recentlyShippedOrders) {
    console.log(typeof order.trackingDetails);
    if (typeof order.trackingDetails == "object") {
      await page.evaluate(() => document.querySelector('#orders-header-search-input').value = '');
      await page.type('#orders-header-search-input', order.trackingDetails.customer, {delay: 100});
      await new Promise(resolve => setTimeout(resolve, 500));
      await page.keyboard.press('Enter');
      await new Promise(resolve => setTimeout(resolve, 2000));
      let customerName = await page.evaluate(() => document.querySelector('#search-view > div > div.panel-body.bg-white > div > div > div.flag-body.pt-xs-3.pt-xl-4.pr-xs-3.pr-md-0 > div > div.col-md-4.pl-xs-0.hide-xs.hide-sm > div:nth-child(4) > div > div > div > div > span').innerText);
      customerName = customerName.toUpperCase();
      console.log(customerName);
      if (customerName == order.trackingDetails.customer) {
        // Found correct customer
        let shipStatus = await page.evaluate(() => document.querySelector('#search-view > div > div.panel-body.bg-white > div:nth-child(1) > div > div.flag-body.pt-xs-3.pt-xl-4.pr-xs-3.pr-md-0 > div.col-group.col-flush > div.col-md-4.pl-xs-0.hide-xs.hide-sm > div.text-body.strong > span > div').innerText);
        console.log(shipStatus);
        let trackingFlag = false;
        if (shipStatus !== 'Pre-transit') {
          // Add tracking # for order that has no tracking already
          console.log('add tracking')
          // Click Update Progress Icon
          await page.click('#search-view > div > div.panel-body.bg-white > div:nth-child(1) > div > div.flag-img.flag-img-right.pt-xs-2.pt-xl-3.pl-xs-2.pl-xl-3.pr-xs-3.pr-xl-3.vertical-align-top.icon-t-2.hide-xs.hide-sm > div > div:nth-child(2) button');
          await new Promise(resolve => setTimeout(resolve, 1000));
          await page.click('#search-view > div > div.panel-body.bg-white > div > div > div.flag-img.flag-img-right.pt-xs-2.pt-xl-3.pl-xs-2.pl-xl-3.pr-xs-3.pr-xl-3.vertical-align-top.icon-t-2.hide-xs.hide-sm > div > div:nth-child(2) > div > div > div > ul > li.pl-xs-2.pr-xs-2.bt-xs-1.pt-xs-2.mt-xs-2 a');
          await new Promise(resolve => setTimeout(resolve, 1500));
          // Enter Tracking Number
          await page.type('.overlay-region > div > div.overlay-body.p-xs-0.height-full.overflow-scroll > div > div:nth-child(2) > div > div.mt-xs-3.mt-md-4.mb-xs-8.mb-md-4.pl-xs-3.pr-xs-3.pb-xs-8.pl-md-5.pr-md-5.pb-md-5.pl-lg-6.pr-lg-6.pb-lg-6 > div.panel.mt-xs-4.mb-xs-0 > div > div > div > div.col-lg-6.col-xl-7.mt-xs-2.mt-md-3.mt-lg-0 > div > div > div.col-md-6.col-lg-12.col-xl-7 > input', order.trackingDetails.number, {delay: 100});
          await new Promise(resolve => setTimeout(resolve, 1500));
          // Select Shipping Company
          await new Promise(resolve => selectShippingCompany(resolve, order));
        }
        // check if tracking # already exists
        if (shipStatus == 'Pre-transit') {
          const trackingNumberHandle = await page.$$('#search-view > div > div.panel-body.bg-white > div:nth-child(1) > div > div.flag-body.pt-xs-3.pt-xl-4.pr-xs-3.pr-md-0 > div > div.col-md-4.pl-xs-0.hide-xs.hide-sm > div:nth-child(3) > div > div .text-body-smaller');
          console.log(trackingNumberHandle.length);
          for (let index = 1; index <= trackingNumberHandle.length; index++) {
            console.log('index', index)
            let selector = '#search-view > div > div.panel-body.bg-white > div:nth-child(1) > div > div.flag-body.pt-xs-3.pt-xl-4.pr-xs-3.pr-md-0 > div.col-group.col-flush > div.col-md-4.pl-xs-0.hide-xs.hide-sm > div:nth-child(3) > div > div > div:nth-child('+index+') > div > span > div.display-inline-block.shipping-description-small > button';
            let _trackingNumber = await page.evaluate((selector) => {
              console.log('selector',selector);
              return document.querySelector(selector).innerText
            }, selector);
            console.log("_trackNumber",_trackingNumber);
            if (_trackingNumber == order.trackingDetails.number) {
              // do nothing
              trackingFlag = true;
            }
          }
        }
        // If tracking does not already exist, add it
        if (trackingFlag == false && shipStatus == 'Pre-transit') {
          // Add second tracking # to order
          console.log('add second tracking');
          // Click Options toggle
          await page.click('#search-view > div > div.panel-body.bg-white > div:nth-child(1) > div > div.flag-img.flag-img-right.pt-xs-2.pt-xl-3.pl-xs-2.pl-xl-3.pr-xs-3.pr-xl-3.vertical-align-top.icon-t-2.hide-xs.hide-sm > div > div:nth-child(3) button');
          await new Promise(resolve => setTimeout(resolve, 1000));
          // Click Add tracking link
          await page.click('#search-view > div > div.panel-body.bg-white > div > div > div.flag-img.flag-img-right.pt-xs-2.pt-xl-3.pl-xs-2.pl-xl-3.pr-xs-3.pr-xl-3.vertical-align-top.icon-t-2.hide-xs.hide-sm > div > div:nth-child(3) > div > div > div > ul > li:nth-child(2) span');
          // Enter Tracking Number
          await page.type('.overlay-region > div > div.overlay-body.p-xs-0.height-full.overflow-scroll > div > div:nth-child(2) > div > div.mt-xs-3.mt-md-4.mb-xs-8.mb-md-4.pl-xs-3.pr-xs-3.pb-xs-8.pl-md-5.pr-md-5.pb-md-5.pl-lg-6.pr-lg-6.pb-lg-6 > div.panel.mt-xs-4.mb-xs-0 > div > div > div > div.col-lg-6.col-xl-7.mt-xs-2.mt-md-3.mt-lg-0 > div > div > div.col-md-6.col-lg-12.col-xl-7 > input', order.trackingDetails.number, {delay: 100});
          await new Promise(resolve => setTimeout(resolve, 1500));
          // Select Shipping Company
          await new Promise(resolve => selectShippingCompany(resolve, order));
        }
        console.log('trackingflag', trackingFlag, shipStatus);
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
  return resolve();
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
  await new Promise(resolve => getOtherCreds(resolve));
  // Check Email for Bad News Messages
  // await new Promise(resolve => checkEmail(resolve));
  // // Login to AliExpress
  // await new Promise(resolve => loginAliExpress(resolve));
  // // Wait
  // await new Promise(resolve => setTimeout(resolve, 1000));
  // // Check AliExpress to see if orders have been delivered
  // await new Promise(resolve => checkDelivery(resolve));
  // // Save delivered and undelivered data in files for later use
  // await new Promise(resolve => saveFile(resolve, undeliveredOrders, 'undelivered.json'));
  // await new Promise(resolve => saveFile(resolve, deliveredOrders, 'delivered.json'));
  // // Mark emails as read
  // await new Promise(resolve => markEmailAsRead(resolve));
  // Check new tracking # emails
  await new Promise(resolve => checkNewTrackingEmails(resolve));
  // Login to AliExpress
  await new Promise(resolve => loginAliExpress(resolve));
  // Get Tracking number
  await new Promise(resolve => getTrackingNumber(resolve));
  // Save Tracking Number Fie
  await new Promise(resolve => saveFile(resolve, recentlyShippedOrders, 'tracking.json'));
  // Login to Etsy
  await new Promise(resolve => loginEtsy(resolve));
  // Add Tracking Numbers in Etsy
  await new Promise(resolve => addTrackingNumbers(resolve));
  // Finish
  console.log('done');
  //openDisputes();
  
}
initializeWorkFlow();
