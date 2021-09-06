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
const checkBadNewsEmail = async (resolve) => {
  authorize(gmailCredentials, 
    async (auth) => {
      const gmail = google.gmail({version: 'v1', auth});
  
      const messageIds = await gmail.users.messages.list({
          userId: 'me',
          q: "bad news",
          labelIds: ['UNREAD']
      }).catch(e => console.log(e))
  
      //console.log('Bad News Email Array: ', messageIds.data.messages);
      if (messageIds.data.resultSizeEstimate !== 0) {
        // console.log('running')
        for (let index = 0; index < messageIds.data.messages.length; index++) {
          let message = await gmail.users.messages.get({
            userId: 'me',
            id: messageIds.data.messages[index].id
          });
          console.log('bad news subject', message.data.payload.headers[21].value.slice(19, 35));
          let orderId = message.data.payload.headers[21].value.slice(19, 35);
          orderArray.push({orderId: orderId, messageId: messageIds.data.messages[index].id});
        }
  
        console.log('Order Id Array ', orderArray);
      }
      
      return resolve();
    }
  )
}

// Opens AliExpress and checks to see if order was delivered
const checkDelivery = async (resolve) => {
  page = await browser.newPage();
  
  for (order of orderArray) {  
    console.log(`${orderDetailUrl}${order.orderId}`)
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
    if (trackingStatus.includes('Delivery') || trackingStatus.includes('Delivered')) {
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
          Status: trackingStatus,
          disputeStatus: false
         });
      } else {
        undeliveredOrders.push({
          orderId: order.orderId, 
          messageId: order.messageId,
          Status: trackingStatus,
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
  recentlyShippedOrders.map(message => {
    mailIds.push(message.messageId);
  })
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
  let aliPage = await browser.newPage();
  // Go to Ali Express
  await Promise.all([
    aliPage.waitForNavigation(),
    aliPage.goto('https://login.aliexpress.com/')
  ])
  // Wait 5 Seconds
  await new Promise(resolve => setTimeout(resolve, 3000));

  // Close Popup
  // let popup = true;
  // let popupIframeContent = '';
  // let popupIframeElement = '';
  //await aliPage.evaluate(() => document.querySelector('body > iframe:nth-child(14)').remove());
  // try {
  //   popupIframeElement = await aliPage.$('body > iframe:nth-child(14)');
  //   popupIframeContent = await popupIframeElement.contentFrame();
  //   // await popupIframeContent.waitForSelector('#recyclerview', {
  //   //   timeout: 5000
  //   // })
  //   console.log('popup')
  // } catch (e) {
  //   console.log('no popup')
  //   popup = false;
  // }


  // if (popup) {
  //   console.log(popupIframeElement)
  //   //popupIframeContent = await popupIframeElement.contentFrame();
  //   console.log(popupIframeContent)
  //   // await popupIframeContent.click('#recyclerview > div > div.mui-zebra-module > div > div > img');
  //   await popupIframeContent.evaluate(() => {
  //     document.querySelector('#recyclerview > div > div.mui-zebra-module > div > div > img').click();
  //   });
  // }
  let signInText = null;
  try {
    signInText = await aliPage.evaluate(() => document.querySelector('#root > div > div > div > div > div > button').innerText);
  } catch (e) {

  }
  
  console.log('Signin Text:', signInText);

  if (signInText == 'ACCESS NOW') {
    await aliPage.click('#root > div > div > div > div > div > button');
  }

  let accessNow = true;
  try {
    await aliPage.waitForSelector('#root > div > div > div > div > button',{
      timeout: 3000
    })
    accessNow = false;

  } catch (error) {
    await aliPage.close();
    return resolve();
  }

  if (!accessNow) {
    //if (signInText == 'SIGN IN') {
      // Wait 
      //await new Promise(resolve => setTimeout(resolve, 5000));
      // Click Sign In Button
      // await aliPage.click('#user-benefits > div:nth-child(1)');
      // Wait 
      await new Promise(resolve => setTimeout(resolve, 1000));
      // Select Login Form from within Iframe
      // const loginIframeElement = await aliPage.$('iframe[id="alibaba-login-box"]');
      // const loginIframeContent = await loginIframeElement.contentFrame();
      // Fill in Username
      // await loginIframeContent.evaluate(() => {
      //   document.querySelector('#fm-login-id').value = '';
      // });
      await aliPage.evaluate(() => {
        document.querySelector('#fm-login-id').value = '';
      });
      // await loginIframeContent.type('#fm-login-id', aliCredentials.username, { delay: 100 });
      await aliPage.type('#fm-login-id', aliCredentials.username, { delay: 100 });
      // Fill in Password
      // await loginIframeContent.type('#fm-login-password', aliCredentials.password, { delay: 100 });
      await aliPage.type('#fm-login-password', aliCredentials.password, { delay: 100 });
      // Wait 1 second
      await new Promise(resolve => setTimeout(resolve, 1000));
      // Keypress Enter
      // await aliPage.keyboard.press('Enter');
      await aliPage.click('#root > div > div > div > div > button');
      await new Promise(resolve => setTimeout(resolve, 5000));
      await aliPage.close();
      return resolve();
    // } else {
    //   console.log('resolve')
    //     // Already signed in
    //     await new Promise(resolve => setTimeout(resolve, 5000));
    //     await aliPage.close();
    //     return resolve();
    // }
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
          maxResults: 30
      });

      console.log(messageIds)
  
      console.log('Tracking Emails Array',messageIds.data.messages);
      if (messageIds.data.resultSizeEstimate !== 0) {
        // console.log('ran')
        for (email of messageIds.data.messages) {
          let message = await gmail.users.messages.get({
            userId: 'me',
            id: email.id
          });
          console.log('Tracking emails subject', message.data.payload.headers[21].value.slice(26, 42));
          let orderId = message.data.payload.headers[21].value.slice(26, 42);
          //console.log(orderId);
          recentlyShippedOrders.push({
            orderId: orderId,
            messageId: email.id
          })
        }
        console.log('recently shipped orders', recentlyShippedOrders);
      }
      return resolve();
    }
  )
}

// Get Tracking number from aliexpress
// Opens AliExpress and checks to see if order was delivered
const getTrackingNumber = async (resolve) => {
  page = await browser.newPage();
  
  for (order of recentlyShippedOrders) {  
    console.log(`${orderDetailUrl}${order.orderId}`)
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
    console.log('tracking status',trackingStatus);

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
  console.log('recent shipped',recentlyShippedOrders);
  return resolve();
};

// Login to Etsy.com
const loginEtsy = async (resolve) => {
  await Promise.all([
    page.waitForNavigation(),
    page.goto('https://etsy.com')
    
  ]);
  // Check if Logged in by evaluating text
  let signInText = null;
  try {
    signInText = await page.evaluate(() => document.querySelector('#gnav-header-inner > div.wt-flex-shrink-xs-0 > nav > ul > li:nth-child(4) > div > div > ul > li:nth-child(6) > a > div.wt-ml-xs-2.wt-flex-grow-xs-1 > p').innerText);
  } catch (error) {

  }
  
  // const loggedin = await page.evaluate(() => {
  //     return document.querySelectorAll('#sub-nav-user-navigation').length;
  // });

  // Check if logged in
  if (signInText == "Sign out") {
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
  
    await page.waitForSelector('#shipping-carrier-select')
    await page.click('#shipping-carrier-select')
    if (order.trackingDetails.shippingCompany == 'FEDEX_US') {
      await page.select('#shipping-carrier-select', '3')
    } else {
      // Select Other
      await page.select('#shipping-carrier-select', '-1')
      // Wait for other input and click
      await page.waitForSelector('#shipping-carrier-select')
      await page.click('#shipping-carrier-select')
      // Enter China EMS in other
      await new Promise(resolve => setTimeout(resolve, 1000));
      await page.type('#mark-as-complete-overlay > div > div > div:nth-child(2) > div > div > div > div:nth-child(2) > div > div > div.wt-grid__item-xs-12.wt-grid__item-md-8.wt-mt-xs-3.wt-mt-md-0 > div > div.wt-grid__item-md-5.wt-grid__item-xs-12 > div.wt-mt-xs-2 > input', 'China EMS', {delay: 100});
    }
    
    await new Promise(resolve => setTimeout(resolve, 500));
    await page.click('#mark-as-complete-overlay > div > div > div.wt-overlay__sticky-footer-container.wt-z-index-1 > div > div:nth-child(3) > button');
    return resolve();
  

  
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
    console.log('type of order: ',typeof order.trackingDetails);
    if (typeof order.trackingDetails == "object") {
      await page.evaluate(() => document.querySelector('#orders-header-search-input').value = '');
      await page.type('#orders-header-search-input', order.trackingDetails.customer, {delay: 100});
      await new Promise(resolve => setTimeout(resolve, 500));
      await page.keyboard.press('Enter');
      await new Promise(resolve => setTimeout(resolve, 2000));
      let customerFound = true;
      try {
        await page.waitForSelector('#search-view > div > div.panel-body.bg-white > div > div > div.flag-body.pt-xs-3.pt-xl-4.pr-xs-3.pr-md-0 > div > div.col-md-4.pl-xs-0.hide-xs.hide-sm > div:nth-child(4) > div > div > div > div > span', {
          timeout: 5000
        })
        
      } catch(e){
        customerFound = false;
      }

      if (customerFound) {
        let customerName = await page.evaluate(() => document.querySelector('#search-view > div > div.panel-body.bg-white > div > div > div.flag-body.pt-xs-3.pt-xl-4.pr-xs-3.pr-md-0 > div > div.col-md-4.pl-xs-0.hide-xs.hide-sm > div:nth-child(4) > div > div > div > div > span').innerText);
        customerName = customerName.toUpperCase();
        console.log('customer name', customerName);
        if (customerName == order.trackingDetails.customer) {
          // Found correct customer
          let shipStatus = await page.evaluate(() => document.querySelector('#search-view > div > div.panel-body.bg-white > div:nth-child(1) > div > div.flag-body.pt-xs-3.pt-xl-4.pr-xs-3.pr-md-0 > div.col-group.col-flush > div.col-md-4.pl-xs-0.hide-xs.hide-sm > div.text-body.strong > span > div').innerText);
          console.log('ship status',shipStatus);
          if (shipStatus == 'Canceled') {
            continue;
          }
          let trackingFlag = false;
          // Add First Trakcing Number
          if (shipStatus !== 'Pre-transit' && (shipStatus !== 'In transit' && shipStatus !== 'Delivered')) {
            // Add tracking # for order that has no tracking already
            console.log('add tracking')
            // Click Update Progress Icon
            await page.click('#search-view > div > div.panel-body.bg-white > div:nth-child(1) > div > div.flag-img.flag-img-right.pt-xs-2.pt-xl-3.pl-xs-2.pl-xl-3.pr-xs-3.pr-xl-3.vertical-align-top.icon-t-2.hide-xs.hide-sm > div > div:nth-child(2) button');
            await new Promise(resolve => setTimeout(resolve, 1000));            
            await page.click('#search-view > div > div.panel-body.bg-white > div > div > div.flag-img.flag-img-right.pt-xs-2.pt-xl-3.pl-xs-2.pl-xl-3.pr-xs-3.pr-xl-3.vertical-align-top.icon-t-2.hide-xs.hide-sm > div > div:nth-child(2) > div > div > div > ul > li.pl-xs-2.pr-xs-2.bt-xs-1.pt-xs-2.mt-xs-2 a');
            
            await new Promise(resolve => setTimeout(resolve, 1500));
            // Enter Tracking Number
            await page.type('#mark-as-complete-overlay > div > div > div:nth-child(2) > div > div > div > div:nth-child(2) > div > div > div.wt-grid__item-xs-12.wt-grid__item-md-8.wt-mt-xs-3.wt-mt-md-0 > div > div.wt-grid__item-md-6.wt-ml-md-6.wt-mt-md-0.wt-grid__item-xs-12.wt-ml-xs-0.wt-mt-xs-1 > input', order.trackingDetails.number, {delay: 100});
            await new Promise(resolve => setTimeout(resolve, 1500));
            // Select Shipping Company
            await new Promise(resolve => selectShippingCompany(resolve, order));
          }
          // Check if tracking # already exists
          if (shipStatus == 'Pre-transit' || (shipStatus == 'In transit' || shipStatus == 'Delivered')) {
            const trackingNumberHandle = await page.$$('#search-view > div > div.panel-body.bg-white > div:nth-child(1) > div > div.flag-body.pt-xs-3.pt-xl-4.pr-xs-3.pr-md-0 > div > div.col-md-4.pl-xs-0.hide-xs.hide-sm > div:nth-child(3) > div > div .text-body-smaller');
            console.log('tracking number length',trackingNumberHandle.length);
            for (let index = 1; index <= trackingNumberHandle.length; index++) {
              console.log('index', index)
              let selector = '#search-view > div > div.panel-body.bg-white > div:nth-child(1) > div > div.flag-body.pt-xs-3.pt-xl-4.pr-xs-3.pr-md-0 > div > div.col-md-4.pl-xs-0.hide-xs.hide-sm > div:nth-child(3) > div > div > div:nth-child('+index+') > div > div > div.display-inline-block.shipping-description-small > button';
              
              let _trackingNumber = await page.evaluate((selector) => {
                //console.log('selector',selector);
                return document.querySelector(selector).innerText
              }, selector);
              _trackingNumber = _trackingNumber.split('e')[1];
              console.log("listed_trackNumber: ", _trackingNumber);
              console.log("trackNumber: ", order.trackingDetails.number);
              if (_trackingNumber.includes(order.trackingDetails.number)) {
                // do nothing
                trackingFlag = true;
              }
            }
          }
          // If tracking does not already exist, add it
          if (trackingFlag == false && (shipStatus == 'Pre-transit' || (shipStatus == 'In transit' || shipStatus == 'Delivered'))) {
            // Add second tracking # to order
            console.log('add second tracking');
            // Click Options toggle
            await page.click('#search-view > div > div.panel-body.bg-white > div:nth-child(1) > div > div.flag-img.flag-img-right.pt-xs-2.pt-xl-3.pl-xs-2.pl-xl-3.pr-xs-3.pr-xl-3.vertical-align-top.icon-t-2.hide-xs.hide-sm > div > div:nth-child(3) button');
            await new Promise(resolve => setTimeout(resolve, 1000));
            // Click Add tracking link
            await page.click('#search-view > div > div.panel-body.bg-white > div > div > div.flag-img.flag-img-right.pt-xs-2.pt-xl-3.pl-xs-2.pl-xl-3.pr-xs-3.pr-xl-3.vertical-align-top.icon-t-2.hide-xs.hide-sm > div > div:nth-child(3) > div > div > button:nth-child(2) > div > span');
            await new Promise(resolve => setTimeout(resolve, 1500));
            // Enter Tracking Number
            await page.type('#mark-as-complete-overlay > div > div > div:nth-child(2) > div > div > div > div:nth-child(2) > div > div > div.wt-grid__item-xs-12.wt-grid__item-md-8.wt-mt-xs-3.wt-mt-md-0 > div > div.wt-grid__item-md-6.wt-ml-md-6.wt-mt-md-0.wt-grid__item-xs-12.wt-ml-xs-0.wt-mt-xs-1 > input', order.trackingDetails.number, {delay: 100});
            
            await new Promise(resolve => setTimeout(resolve, 1500));
            // Select Shipping Company
            await new Promise(resolve => selectShippingCompany(resolve, order));
          }
          console.log('trackingflag', trackingFlag, shipStatus);
        }
      }
      
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
  return resolve();
}

// Add Product to Cart on Aliexpress
const addProductToCart = async (resolve, href, attribute, shipsFrom, style) => {
  // Login to AliExpress
  //await new Promise(resolve => loginAliExpress(resolve));
  // Open New Product Page
  let productPage = await browser.newPage();
  // Go to product page
  await Promise.all([
    productPage.waitForNavigation(),
    productPage.goto(href)  
  ]);
  // Select attribute
  const skuProperty = await productPage.$$('.sku-wrap > .sku-property');
  console.log('skuPropertyLength:', skuProperty.length);
  
  for (let index = 1; index <= skuProperty.length; index++) {
    let skuTitle =  await productPage.evaluate((index) => document.querySelector('.sku-wrap > div:nth-child('+index+') .sku-title').innerText, index);
    skuTitle = skuTitle.trim();
    console.log('sku Title:', skuTitle);
    if (skuTitle == 'Color:' || skuTitle == 'Emitting Color:') {
      if (style !== '0' && style !== false) {
        await productPage.click('#root > div > div.product-main > div > div.product-info > div.product-sku > div > div:nth-child('+index+') > ul > li:nth-child('+style+')');
      }
    } else if (skuTitle == 'Size:' || (skuTitle == 'Emitting Color:' || (skuTitle == 'Metal Color:' || skuTitle == 'Length:')) ) {
      console.log('ran', index, attribute)
      if (attribute !== '0' && attribute !== false) {
        console.log('ran', index)
        await productPage.click('#root > div > div.product-main > div > div.product-info > div.product-sku > div > div:nth-child('+index+') > ul > li:nth-child('+attribute+')');
      }
    } else if (skuTitle == 'Ships From:') {
      if (shipsFrom !== '0' && shipsFrom !== false) {
        await productPage.click('#root > div > div.product-main > div > div.product-info > div.product-sku > div > div:nth-child('+index+') > ul > li:nth-child('+shipsFrom+')');
      }
    }
  }

  // //console.log('attribute: ',attribute)
  // await new Promise(resolve => setTimeout(resolve, 1000));
  // if (attribute !== '0' && attribute !== false) {
  //   await productPage.click('.sku-property > .sku-property-list > .sku-property-item:nth-child('+attribute+')')
  // }

  // // Select Ships from if Applicable
  // //console.log('ships from: ',shipsFrom)
  // await new Promise(resolve => setTimeout(resolve, 1000));
  // if (shipsFrom !== '0' && shipsFrom !== false) {
  //   await productPage.click('#root > div > div.product-main > div > div.product-info > div.product-sku > div > div:nth-child(2) > ul > li:nth-child('+shipsFrom+')');
  // }
  // // Select Style if Applicable
  // await new Promise(resolve => setTimeout(resolve, 1000));
  // if (style !== '0' && style !== false) {
  //   await productPage.click('#root > div > div.product-main > div > div.product-info > div.product-sku > div > div:nth-child(1) > ul > li:nth-child('+style+')');
    
  // }
  
  // Click Add to cart button
  await new Promise(resolve => setTimeout(resolve, 1000));
  await productPage.click('#root > div > div.product-main > div > div.product-info > div.product-action > span.addcart-wrap > button')
  
  // Close page
  await new Promise(resolve => setTimeout(resolve, 3000));
  await productPage.close();
  return resolve();
}

const unabbreviateState = (state) => {
  const stateData = ['Alabama - AL','Alaska - AK','Arizona - AZ','Arkansas - AR','California - CA','Colorado - CO','Connecticut - CT','Delaware - DE','Florida - FL','Georgia - GA','Hawaii - HI','Idaho - ID','Illinois - IL','Indiana - IN','Iowa - IA','Kansas - KS','Kentucky - KY','Louisiana - LA','Maine - ME','Maryland - MD','Massachusetts - MA','Michigan - MI','Minnesota - MN','Mississippi - MS','Missouri - MO','Montana - MT','Nebraska - NE','Nevada - NV','New Hampshire - NH','New Jersey - NJ','New Mexico - NM','New York - NY','North Carolina - NC','North Dakota - ND','Ohio - OH','Oklahoma - OK','Oregon - OR','Pennsylvania - PA','Rhode Island - RI','South Carolina - SC','South Dakota - SD','Tennessee - TN','Texas - TX','Utah - UT','Vermont - VT','Virginia - VA','Washington - WA','West Virginia - WV','Wisconsin - WI','Wyoming - WY', 'District of Columbia - DC'];

  for (_stateData of stateData) {
    if (_stateData.includes(state)) {
      return _stateData.split(" -")[0];
    }
  }
}

const addPrivateMessage = async (resolve, msg) => {
  // Click add private note
  try {
    await page.click('div > .col-group > .col-xs-12 > .btn:nth-child(1) > .text-body-smaller');
  } catch {
    await page.click('#order-detail-container > div.col-group.mb-xs-4 > div > div > div > div > div.flag-body.vertical-align-top > div.mt-xs-1 > div > div > button');

  }
  // Enter Error Note
  await new Promise(resolve => setTimeout(resolve, 1000));
  await page.type('.flag #private_note_textarea', msg);
  // Click Save Note
  await new Promise(resolve => setTimeout(resolve, 500));
  await page.click('.flag-body > div > .mt-xs-2 > .text-right > .btn-orange');
  return resolve();
}

// Check out on Ali
const checkout = async (resolve) => {
  let checkoutPage = await browser.newPage();
  await new Promise(resolve => setTimeout(resolve, 1000));
  await Promise.all([
    checkoutPage.waitForNavigation(),
    checkoutPage.goto('https://shoppingcart.aliexpress.com/shopcart/shopcartDetail.htm')  
  ]);
  await new Promise(resolve => setTimeout(resolve, 2000));
  // Select all products in cart
  await checkoutPage.click('#root > div > div > div:nth-child(1) > div.main > div.card-container.captain-container > div > div.select-all-container > label > span.next-checkbox > input');
  
  // Click Buy and navigate to Billing Page
  await new Promise(resolve => setTimeout(resolve, 3000));
  
  // await checkoutPage.click('#checkout-button > span')

  await Promise.all([
    checkoutPage.waitForNavigation(),
    checkoutPage.click('#checkout-button') 
  ]);
  
  await new Promise(resolve => setTimeout(resolve, 10000));
  // Save address details from auto fill helper
  let name = await checkoutPage.evaluate(() => document.querySelector('.autoFillContainer #name').innerText);
  let firstLine = await checkoutPage.evaluate(() => document.querySelector('.autoFillContainer #firstLine').innerText);
  let secondLine = await checkoutPage.evaluate(() => document.querySelector('.autoFillContainer #secondLine').innerText);
  let city = await checkoutPage.evaluate(() => document.querySelector('.autoFillContainer #city').innerText);
  let state = await checkoutPage.evaluate(() => document.querySelector('.autoFillContainer #state').innerText);
  let country = await checkoutPage.evaluate(() => document.querySelector('.autoFillContainer #country').innerText);
  if (country == 'UNITED STATES') {
    state = unabbreviateState(state);
  }
  let zip = await checkoutPage.evaluate(() => document.querySelector('.autoFillContainer #zip').innerText);

  // 2021 Ali New Address Design
  // Enter Address Details
  await checkoutPage.click('#main > div:nth-child(1) > div > div.address-list-opt > button:nth-child(2)')
  await new Promise(resolve => setTimeout(resolve, 2000));
  await checkoutPage.click('body > div.next-overlay-wrapper.opened > div.next-overlay-inner.next-dialog-container > div > div.next-dialog-body > div > ul > li > div.address-opt > button:nth-child(2)')
  // 2021 Ali New Address Design

  // 2020 Ali Old Address Design
  // Click on Address
  // await checkoutPage.waitForSelector('.display-card > .next-radio-wrapper > .next-radio-label > .address-item > .address-main')
  // await checkoutPage.click('.display-card > .next-radio-wrapper > .next-radio-label > .address-item > .address-main')
  // // Click edit address button
  // await new Promise(resolve => setTimeout(resolve, 2000));
  // await checkoutPage.click('.address-opt > button:nth-child(1)')
  // 2020 Ali Old Address Design

  // await checkoutPage.waitForSelector('.next-radio-wrapper > .next-radio-label > .address-item > .address-opt > .next-btn:nth-child(1)')
  // await checkoutPage.click('.next-radio-wrapper > .next-radio-label > .address-item > .address-opt > .next-btn:nth-child(1)')
  
  // Enter Name
  await new Promise(resolve => setTimeout(resolve, 3000));
  await checkoutPage.click('.group-content #contactPerson')

  for (let index = 0; index < 40; index++) {
    await checkoutPage.keyboard.press('Backspace');
  }
  await checkoutPage.type('.group-content #contactPerson', name, { delay: 100 });
  
  // Enter Address
  await new Promise(resolve => setTimeout(resolve, 500));
  await checkoutPage.click('.group-content #address')
  await new Promise(resolve => setTimeout(resolve, 500));
  await checkoutPage.keyboard.press('ArrowRight');
  await new Promise(resolve => setTimeout(resolve, 500));
  await checkoutPage.keyboard.press('ArrowRight');
  await new Promise(resolve => setTimeout(resolve, 500));
  await checkoutPage.keyboard.press('ArrowRight');
  await new Promise(resolve => setTimeout(resolve, 500));
  await checkoutPage.keyboard.press('ArrowRight');
  for (let index = 0; index < 40; index++) {
    await checkoutPage.keyboard.press('Backspace');
  }
  await checkoutPage.type('.group-content #address', firstLine, { delay: 100 });
  await new Promise(resolve => setTimeout(resolve, 500));
  await checkoutPage.click('.group-content #address2')

  for (let index = 0; index < 30; index++) {
    await checkoutPage.keyboard.press('Backspace');
  }
  await checkoutPage.type('.group-content #address2', secondLine, { delay: 100 });

  // Enter Zip Code
  await new Promise(resolve => setTimeout(resolve, 1000));
  await checkoutPage.click('.group-content #zip')
  await new Promise(resolve => setTimeout(resolve, 500));
  await checkoutPage.keyboard.press('ArrowRight');
  await new Promise(resolve => setTimeout(resolve, 500));
  await checkoutPage.keyboard.press('ArrowRight');
  await new Promise(resolve => setTimeout(resolve, 500));
  await checkoutPage.keyboard.press('ArrowRight');
  await new Promise(resolve => setTimeout(resolve, 500));
  await checkoutPage.keyboard.press('ArrowRight');
  for (let index = 0; index < 15; index++) {
    await checkoutPage.keyboard.press('Backspace');
  }
  await checkoutPage.type('.group-content #zip', zip, { delay: 100 });

  // Select Country
  await new Promise(resolve => setTimeout(resolve, 2500));
  await checkoutPage.waitForSelector('.search-select:nth-child(1) > .zoro-ui-select > .next-select > .next-input > .next-select-values');
  await checkoutPage.click('.search-select:nth-child(1) > .zoro-ui-select > .next-select > .next-input > .next-select-values');
  //await new Promise(resolve => setTimeout(resolve, 1000));
  // await checkoutPage.type('#ae-search-select-3', country.charAt(0), { delay: 100 });
  await new Promise(resolve => setTimeout(resolve, 1000));
  const countries = await checkoutPage.$$('.next-menu > .dropdown-content > .next-menu-item');
  //console.log('countries:', countries.length);

  for (let index = 1; index <= countries.length; index++) {
    let innerText = await checkoutPage.evaluate((index) => document.querySelector('.next-menu > .dropdown-content > .next-menu-item:nth-child('+index+') > .country-item > .country-name').innerText, index);
    
    if (innerText.toUpperCase() == country) {
      //console.log('index of country:', index);
      await checkoutPage.click('.next-menu > .dropdown-content > .next-menu-item:nth-child('+index+') > .country-item > .country-name');
      break;
    }
  }

  await new Promise(resolve => setTimeout(resolve, 8000));
  // Select State
  await checkoutPage.waitForSelector('.search-select:nth-child(2) > .zoro-ui-select > .next-select > .next-input > .next-input-control > .next-select-arrow > .next-icon')
  await checkoutPage.click('.search-select:nth-child(2) > .zoro-ui-select > .next-select > .next-input > .next-input-control > .next-select-arrow > .next-icon')
  // await new Promise(resolve => setTimeout(resolve, 1500));
  // await checkoutPage.type('#ae-search-select-3', state.charAt(1), { delay: 100 });
  await new Promise(resolve => setTimeout(resolve, 1000));
  const states = await checkoutPage.$$('.opened > .next-overlay-inner > .next-menu > .dropdown-content > .next-menu-item');
  //console.log('states:', states.length);

  for (let index = 1; index <= states.length; index++) {
    let innerText = await checkoutPage.evaluate((index) => document.querySelector('body > div.next-overlay-wrapper.opened > div > div > ul > li:nth-child('+index+')').innerText, index);
    //console.log('dropdownState = ',innerText.toUpperCase(),)
    //console.log('state', state.toUpperCase())
    if (innerText.toUpperCase() == state.toUpperCase()) {
      //console.log('index of state:', index);
      await checkoutPage.click('.opened > .next-overlay-inner > .next-menu > .dropdown-content > .next-menu-item:nth-child('+ index +')')
      break;
    }
  }

  await new Promise(resolve => setTimeout(resolve, 5000));
  // Select City
  let cityDropDown = true;
  // Check if city is drop down
  try {
    await page.waitForSelector('.search-select:nth-child(3) > .zoro-ui-select > .next-select > .next-input > .next-select-values', {
      timeout: 10000
    });
    
  } catch (e) {
    if (e instanceof puppeteer.errors.TimeoutError) {
      // Is not a dropdown
      //cityDropDown = false;
      console.log('it didnt work')
    }
  }
  if (cityDropDown) {
    // Loop through cities and select
    let dropdown = await checkoutPage.click('.search-select:nth-child(3) > .zoro-ui-select > .next-select > .next-input > .next-select-values')
    // await new Promise(resolve => setTimeout(resolve, 1000));
    // await checkoutPage.type('#ae-search-select-3', city.charAt(0), { delay: 100 });
    
    await new Promise(resolve => setTimeout(resolve, 1000));

    const cities = await checkoutPage.$$('.opened > .next-overlay-inner > .next-menu > .dropdown-content > .next-menu-item');
    console.log('cities:', cities.length);

    for (let index = 1; index <= cities.length; index++) {
      let innerText = await checkoutPage.evaluate((index) => document.querySelector('.opened > .next-overlay-inner > .next-menu > .dropdown-content > .next-menu-item:nth-child('+index+')').innerText, index);
      console.log(innerText.toUpperCase(), 'state', city.toUpperCase());
      if (innerText.toUpperCase() == city.toUpperCase()) {
        console.log('index of city:', index);
        await checkoutPage.click('.opened > .next-overlay-inner > .next-menu > .dropdown-content > .next-menu-item:nth-child('+ index +')')
        break;
      }
    }
  } else {
    // Type City
    await checkoutPage.click('#city')
    await checkoutPage.type('#city', city.toUpperCase(), { delay: 100 });
  }
  

  // Enter Phone #
  await new Promise(resolve => setTimeout(resolve, 500));
  // await checkoutPage.type('.group-content #mobileNo', '5108584530', { delay: 100 });

  // Click Save Address and Continue
  // await checkoutPage.click('.next-loading > .next-loading-wrap > .ship-info > .save > .next-btn-primary') 2020 old address design
  await checkoutPage.click('body > div.next-overlay-wrapper.opened > div.next-overlay-inner.next-dialog-container > div > div.next-dialog-body > div > div > div > div.save > button.next-btn.next-large.next-btn-primary')

  
  // Select Shipping
  const changeShippingCount = await checkoutPage.$$('.logistics-company');
  console.log('# of products in cart:', changeShippingCount.length);
  
  for (let index = 2; index < changeShippingCount.length + 2; index++) {
    await new Promise(resolve => setTimeout(resolve, 2000));
    await checkoutPage.click('#main > div.card-container.orders-list > div > div > div > div > div:nth-child('+index+') > div > div.product-field.product-main > div.product-logistics > span.logistics-company');
    
    // await checkoutPage.click('.shopping-cart-product > .product-container > .product-field > .product-logistics > .logistics-company');
    await new Promise(resolve => setTimeout(resolve, 1000));
    const shippingCos = await checkoutPage.$$('body > div.next-overlay-wrapper.opened > div.next-overlay-inner.next-dialog-container > div > div.next-dialog-body > div > div > div > div > div > div');

    console.log('shippingCompanieslength:', shippingCos.length);

    let closeShippingPopup = async (resolve) => {
      // Close Shipping Popup
      await new Promise(resolve => setTimeout(resolve, 1000));
      await checkoutPage.click('.next-overlay-wrapper > .next-overlay-inner > .next-dialog > .next-dialog-footer > .next-btn')
      return resolve();
    }
    // Check if its Epacket
    let epacket = false;
    // for (let index = 2; index <= shippingCos.length; index++) {
    //   await new Promise(resolve => setTimeout(resolve, 1000));
    //   let innerText = await checkoutPage.evaluate((index) => document.querySelector('body > div.next-overlay-wrapper.opened > div.next-overlay-inner.next-dialog-container > div > div.next-dialog-body > div > div > div > div > div > div:nth-child('+index+') > div:nth-child(5) > div').innerText, index);
    //   await new Promise(resolve => setTimeout(resolve, 1000));
    //   console.log('Shipping Company:', innerText, index);
    //   if (innerText == 'ePacket') {
    //     await checkoutPage.click('.logistics-list > .next-radio-group > .table-tr:nth-child('+index+') > .table-td > .service-name');
    //     await new Promise(resolve => closeShippingPopup(resolve));
    //     epacket = true;
    //     break;
    //   }
    // }
    // Check if its Ali Express Standard Shipping
    let ali = false;
    if (!epacket) {
      for (let index = 2; index <= shippingCos.length; index++) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        let innerText = await checkoutPage.evaluate((index) => document.querySelector('body > div.next-overlay-wrapper.opened > div.next-overlay-inner.next-dialog-container > div > div.next-dialog-body > div > div > div > div > div > div:nth-child('+index+') > div:nth-child(5) > div').innerText, index);
        console.log('Shipping Company:', innerText, index);
        if (innerText == 'AliExpress Standard Shipping') {
          await checkoutPage.click('.logistics-list > .next-radio-group > .table-tr:nth-child('+index+') > .table-td > .service-name');
          await new Promise(resolve => closeShippingPopup(resolve));
          ali = true;
          break;
        }
      }
    }
    
    if (!ali && !epacket) {
      for (let index = 2; index <= shippingCos.length; index++) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        let innerText = await checkoutPage.evaluate((index) => document.querySelector('body > div.next-overlay-wrapper.opened > div.next-overlay-inner.next-dialog-container > div > div.next-dialog-body > div > div > div > div > div > div:nth-child('+index+') > div:nth-child(5) > div').innerText, index);
        console.log('Shipping Company:', innerText, index);
        if (innerText == 'FEDEX') {
          await checkoutPage.click('.logistics-list > .next-radio-group > .table-tr:nth-child('+index+') > .table-td > .service-name');
          await new Promise(resolve => closeShippingPopup(resolve));
          break;
        }
      }
    }
  }

  // Add Dropshipping note
  await new Promise(resolve => setTimeout(resolve, 500));
  await checkoutPage.click('.product-container > .product-field > .message-container > .seller-message > .seller-message-title')
  await new Promise(resolve => setTimeout(resolve, 500));
  await checkoutPage.click('body #pasteMessage')

  //Place Order
  await new Promise(resolve => setTimeout(resolve, 10000));
  await Promise.all([
    checkoutPage.waitForNavigation(),
    checkoutPage.click('#checkout-button') 
  ]);

  // Wait for Successful Redirect and confirm
  await new Promise(resolve => setTimeout(resolve, 10000));
  let successMessage = await checkoutPage.evaluate(() => document.querySelector('.next-message-title').innerText);
  
  // Uncomment for Test Purpose && Comment Line Above - Remove After Dev.
  // let successMessage = 'Payment Successful';
  console.log('successMessage: ', successMessage);

  if (successMessage == 'Payment Successful') {
    // Return to etsy TODO: ADD note of order number
    checkoutPage.close();
    return resolve();
  } else {
    
    // Pop back into etsy and add note that it failed.
    await new Promise(resolve => setTimeout(resolve, 1000));
    const etsyTab = (await browser.pages())[1];
    // Click add private note
    await new Promise(resolve => setTimeout(resolve, 500));
    await new Promise(resolve => addPrivateMessage(resolve, 'Error on Automation Checkout'));
    // Close Checkout Page
    await checkoutPage.close();
    return resolve();
  }
}

const removeSpecialCharacters = (str) => {
  let string = str.replace(/[^a-zA-Z0-9 ]/g, '');
  string = string.toUpperCase();
  return string;
}

// Start processing Automated orders on Etsy
const processOrders = async (resolve) => {
  await Promise.all([
    page.waitForNavigation(),
    page.goto('https://www.etsy.com/your/orders/sold/922888701928?page=1')  
  ]);
  // Select 50 orders per page
  await new Promise(resolve => setTimeout(resolve, 1000));
  await page.waitForSelector('div > .wt-display-flex-xs > .wt-mb-xs-2 > .wt-select > .btn')
  await page.click('div > .wt-display-flex-xs > .wt-mb-xs-2 > .wt-select > .btn')
  await page.select('div > .wt-display-flex-xs > .wt-mb-xs-2 > .wt-select > .btn', '50')
  
  // Count # of Orders
  await new Promise(resolve => setTimeout(resolve, 3000));
  const orders = await page.$$('.orders-full-width-panel-on-mobile .flag-body .col-xs-12');
  console.log('orderLength: ',orders.length);
  const orderCount = orders.length;
  
  // Start Loop
  for (let index = 1; index <= orderCount; index++) {
    // Click on First Order
    console.log("order Loop Index:", index)
    await new Promise(resolve => setTimeout(resolve, 5000));
    await page.click('#browse-view > div > div.col-lg-9.pl-xs-0.pl-md-4.pr-xs-0.pr-md-4.pr-lg-0.float-left > div:nth-child(3) > div:nth-child(2) > div.panel-body > div > div > div.flag-body.pt-xs-3.pt-xl-4.pr-xs-3.pr-md-0 > div > div.col-xs-12.col-md-8');
    

    // Count Product in Order
    await new Promise(resolve => setTimeout(resolve, 4000));
    let items = await page.$$('#order-detail-container > div.pt-xs-2.pb-xs-4 > div > div > div > table > tbody > tr.bb-xs-1');
    console.log('itemLength: ',items.length);

    // Check if item is an Ali product 
    let isAliProduct = true;
    let cart = false;
    let i = 0;
    for (i = 2; i <= items.length + 1; i++) {
      isAliProduct = true;
      // Wait for Ali Extension Text to Appear
      try {
        await page.waitForSelector('#order-detail-container > div.pt-xs-2.pb-xs-4 > div > div > div > table > tbody > tr:nth-child('+i+') > a', {
          timeout: 10000
        });
      } catch (e) {
        if (e instanceof puppeteer.errors.TimeoutError) {
          // Is not an ali product
          isAliProduct = false;
        }
      }
      console.log('is Ali:', isAliProduct, i);

      // Handle if is Ali Product
      if (isAliProduct) {
        // Get Customer Name
        let customerName = await page.evaluate((i) => document.querySelector('#order-detail-container > div:nth-child(5) > div > div > div > div > div > div.col-xs-12.col-md-4 > div > div > p > span.name').innerHTML);
        // Add Product Note of Customers Name
        await new Promise(resolve => setTimeout(resolve, 500));
        await new Promise(resolve => addPrivateMessage(resolve, removeSpecialCharacters(customerName)));
        cart = true;
        // Click Save the Address
        await new Promise(resolve => setTimeout(resolve, 500));
        await page.click('.col-group #saveAddress')
        await new Promise(resolve => setTimeout(resolve, 500));
        // Get Product URL
        let href = await page.evaluate((i) => document.querySelector('#order-detail-container > div.pt-xs-2.pb-xs-4 > div > div > div > table > tbody > tr:nth-child('+i+') > a').href, i);
        await new Promise(resolve => setTimeout(resolve, 500));
        let attribute = true;
        let shipsFrom = true;
        let style = true;
        // Check if product has attribute
        try {
          await page.waitForSelector('#productAttr', {
            timeout: 3000
          });
        } catch (e) {
          if (e instanceof puppeteer.errors.TimeoutError) {
            // No Attribute
            attribute = false;
          }
        }
        // Check if product has shipsFrom
        try {
          await page.waitForSelector('#shipsFrom', {
            timeout: 3000
          });
        } catch (e) {
          if (e instanceof puppeteer.errors.TimeoutError) {
            // No Attribute
            shipsFrom = false
          }
        }
        // Check if product has style
        try {
          await page.waitForSelector('#style', {
            timeout: 3000
          });
        } catch (e) {
          if (e instanceof puppeteer.errors.TimeoutError) {
            // No Attribute
            style = false
          }
        }
        if (attribute) {
          attribute = await page.evaluate((i) => document.querySelector('#order-detail-container > div.pt-xs-2.pb-xs-4 > div > div > div > table > tbody > tr:nth-child('+i+') > #productAttr').innerText, i);
          attribute = attribute.split('Attr: ')[1];
        }

        if (shipsFrom) {
          shipsFrom = await page.evaluate((i) => document.querySelector('#order-detail-container > div.pt-xs-2.pb-xs-4 > div > div > div > table > tbody > tr:nth-child('+i+') > #shipsFrom').innerText, i);
          
          shipsFrom = shipsFrom.split('Ships From: ')[1];
        }
        if (style) {
          style = await page.evaluate((i) => document.querySelector('#order-detail-container > div.pt-xs-2.pb-xs-4 > div > div > div > table > tbody > tr:nth-child('+i+') > #style').innerText, i);
          style = style.split('Style: ')[1];
        }
        
        await new Promise(resolve => setTimeout(resolve, 500));
        console.log('Product link: ',href)
        console.log('Attribute: ',attribute)
        console.log('Ships from: ',shipsFrom)
        console.log('Style: ',style)
        // Add Product to Cart on Ali
        await new Promise(resolve => addProductToCart(resolve, href, attribute, shipsFrom, style));
      }
    }
    console.log('cart:', cart);
    // Exit Item Loop and Check 
    if (cart) {
      // Checkout on Ali
      await new Promise(resolve => checkout(resolve));
      // Open Update Progress Drop down on Etsy
      await new Promise(resolve => setTimeout(resolve, 1000));
      await page.click('#order-detail-container > div.col-group.mt-xs-4.mb-xs-2 > div:nth-child(2) > span > span.wt-pl-xs-0.wt-pr-xs-0.order-states-dropdown > span > div > button > span.wt-menu__trigger__label.undefined > div > span.strong')
      
      // Mark order as In Progress
      await new Promise(resolve => setTimeout(resolve, 1000));
      await page.click('#order-detail-container > div.col-group.mt-xs-4.mb-xs-2 > div:nth-child(2) > span > span.wt-pl-xs-0.wt-pr-xs-0.order-states-dropdown > span > div > div > button:nth-child(3) > span')
      // Close current order
      await new Promise(resolve => setTimeout(resolve, 5000));
      if (index < orderCount) {
        await page.click('#root > div > div:nth-child(3) > div > div.position-fixed.height-full.position-top.position-left.width-full > div.peek-overlay.col-md-9.col-lg-7.col-xl-6.bg-gray.animated.position-absolute.position-top.position-right.pr-xs-0.pl-xs-0.height-full.animated-slide-in-left > button');
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      
      // Mark Order as In progress on Etsy
    } else {
      // Close current order
      await new Promise(resolve => setTimeout(resolve, 5000));
      await page.click('#root > div > div:nth-child(4) > div > div.position-fixed.height-full.position-top.position-left.width-full > div.peek-overlay.col-md-9.col-lg-7.col-xl-6.bg-gray.animated.position-absolute.position-top.position-right.pr-xs-0.pl-xs-0.height-full.animated-slide-in-left > button');
      await new Promise(resolve => setTimeout(resolve, 5000));
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
        '--disable-extensions-except=/Users/aricsangchat/Documents/sites/AliAddressAutoFill/extension',
        '--load-extension=/Users/aricsangchat/Documents/sites/AliAddressAutoFill/extension',
        // '--disable-extensions-except=../../../../../../AliAddressAutoFill/extension',
        // '--load-extension=../../AliAddressAutoFill/extension/',
    ],
    defaultViewport: null,
    userDataDir: "./user_data"
  });
  // open new page in browser
  page = await browser.newPage();
  // Get gmail creds
  await new Promise(resolve => getGmailCreds(resolve));
  // // Get Other, ali and etsy creds
  await new Promise(resolve => getOtherCreds(resolve));
  // Login to Etsy
  await new Promise(resolve => loginEtsy(resolve));
  // Login to AliExpress
  await new Promise(resolve => loginAliExpress(resolve));
  // Start processing orders
  await new Promise(resolve => processOrders(resolve));
  // Check Email for Bad News Messages
  await new Promise(resolve => checkBadNewsEmail(resolve));
  // Wait
  await new Promise(resolve => setTimeout(resolve, 1000));
  // Check AliExpress to see if orders have been delivered
  await new Promise(resolve => checkDelivery(resolve));
  // Save delivered and undelivered data in files for later use
  await new Promise(resolve => saveFile(resolve, undeliveredOrders, 'undelivered.json'));
  await new Promise(resolve => saveFile(resolve, deliveredOrders, 'delivered.json'));
  
  // Check new tracking # emails
  await new Promise(resolve => checkNewTrackingEmails(resolve));
  // Login to AliExpress
  //await new Promise(resolve => loginAliExpress(resolve));
  // Get Tracking number
  await new Promise(resolve => getTrackingNumber(resolve));
  // Save Tracking Number Files
  await new Promise(resolve => saveFile(resolve, recentlyShippedOrders, 'tracking.json'));
  // Login to Etsy
  //await new Promise(resolve => loginEtsy(resolve));
  // Add Tracking Numbers in Etsy
  await new Promise(resolve => addTrackingNumbers(resolve));
  // Mark bad news and tracking emails as read
  await new Promise(resolve => markEmailAsRead(resolve));
  
  // Finish
  console.log('done');
  //openDisputes();
  
}
initializeWorkFlow();
