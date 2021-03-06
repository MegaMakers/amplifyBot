const { App } = require('@slack/bolt');
const twitter = require('twitter');
const emoji = require('node-emoji');

const msgTxtForTweeting = ':twitter:';
const patternForTwitterUrl = 'https:..twitter.com.[^/]*.status.(\d*)';
const reactionCntForApproval = 3;
const userPostLimit = 1000 * 60 * 1 * 60 * 24; // 1 post per 24 hours
const tweetWithoutApprovalLimit = 1000 * 60 * 15; // 15 min

// should ideally use an off-the-shelf logger
var log = {
  _dtStr: function() {
    return (new Date()).toISOString();
  },
  info: function(msg, params) {
    if (!params)
      console.log(`[${log._dtStr()}] INFO: ${msg}`);
    else
      console.log(`[${log._dtStr()}] INFO: ${msg}`, params);
  },
  error: function(msg, params) {
    if (!params)
      console.err(`[${log._dtStr()}] ERR: ${msg}`);
    else
      console.err(`[${log._dtStr()}] ERR: ${msg}`, params);
  }
}


// Initialize Twitter
var twitterClient = new twitter({
  consumer_key: process.env.TWITTER_CONSUMER_KEY,
  consumer_secret: process.env.TWITTER_CONSUMER_SECRET,
  access_token_key: process.env.TWITTER_ACCESS_TOKEN_KEY,
  access_token_secret: process.env.TWITTER_ACCESS_TOKEN_SECRET
});

// Initialize Slack
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET
});
let slackPost = async (channel, user, msgToSend, blocks) => {
  log.info(`posting: ${msgToSend}`);
  let msg = {
    token: process.env.SLACK_BOT_TOKEN,
    channel,
    user,
    text: msgToSend
  };
  if (blocks) msg.blocks = blocks;
  return await app.client.chat.postMessage(msg);
};
let slackPostEphemeral = async (channel, user, msgToSend, blocks) => {
  log.info(`ephemerally posting: ${msgToSend}`);
  let msg = {
    token: process.env.SLACK_BOT_TOKEN,
    channel,
    user,
    text: msgToSend
  };
  if (blocks) msg.blocks = blocks;
  return await app.client.chat.postEphemeral(msg);
};

// debug mode:
// - triggers pipeline on all messages (and not just ones with msgTxtForTweeting)
// - disables posting to twitter and only dumps to console
// - reactions can be from same user (for approvals)
var debugMode = process.env.DEBUG_MODE || false;

const extractText = function(slackMsg) {
  let extractedMsg = slackMsg.text;

  if (!extractedMsg) {
    log.error('Requested extractText but no found text. Full message:', slackMsg);
    return null;
  }

  // remove the twitter indicator
  extractedMsg = extractedMsg.replace(new RegExp(msgTxtForTweeting, 'g'),'');

  // convert emoticons from slack representation to twitter
  extractedMsg = emoji.emojify(extractedMsg);

  // strip <> from url's
  while (extractedMsg.match(/<http[^\s]*>/)) {
    var prefix = extractedMsg.substring(0, extractedMsg.match(/<http[^\s]*>/).index);
    var urlEndNdx = extractedMsg.indexOf('>', prefix.length);
    var url = extractedMsg.substring(prefix.length+1, urlEndNdx);
    if (url.indexOf('|') != -1) url = url.substring(url.indexOf('|')+1);
    extractedMsg = prefix + url + extractedMsg.substring(urlEndNdx+1);
  }

  return extractedMsg;
}


// Pipeline methods
// - need to return params if the pipeline is to continue

////////////////////////////////////////////////////////
// Message Pipeline
// All receive params:{context, body, payload, event, message, say, next}
////////////////////////////////////////////////////////

const filterChannelJoins = async function(params) {
  if (params.message.subtype && params.message.subtype === 'channel_join') return;
  return params;
}

var postCache = {}; // TODO: ideally move to a db
const checkUserPostLimits = function(validDelay) {
  let checkSpecifiedUserPostLimits = async function(params) {
    let userId = params.message.user;
    let now = new Date();
    let lastPost = postCache[userId] && postCache[userId].lastPostTime;
    if (lastPost) {
      if (now - lastPost < validDelay) return;
    }
    return params;
  }
  return checkSpecifiedUserPostLimits;
}

const confirmMsgForTweet = async function(params) {
  let msgToTweet = extractText(params.message);

  let notifyTxt = 'Want me to tweet?'
  let msgToSend = `Hey there <@${params.message.user}>! - I can tweet that for you.`;
  let prompt = `Shall I go ahead and tweet:
\`\`\`
${msgToTweet}
\`\`\`
Note: I don't currently support *all* emojis, while they might show up in Slack they won't appear on Twitter.`;

  let getButtonBlock = (actionId, actionValue, btnText, btnStyle)=>{
    return {
      type: 'button',
      text: {
        type: 'plain_text',
        text: btnText
      },
      style: btnStyle, // default, primary, danger
      action_id: `${actionId}_${actionValue}`,
      value: actionValue
    };
  };

  let actionId = 'tweetConfirmation_' + params.message.ts;
  await slackPostEphemeral(params.message.channel, params.message.user, notifyTxt, [
    { type: 'section',
      text: {
        type: 'mrkdwn',
        text: `${msgToSend}\n${prompt}`
    }},
    { type: 'actions',
      elements: [
        getButtonBlock(actionId, 'yes', 'Yes, please!', 'primary'),
        getButtonBlock(actionId, 'no' , 'No, thank you.', 'danger'),
    ]}
  ]);

  return params;
}

// QueueTweetWithExpiry will add the tweet and content to a cache which expires after a finite amount of time (default 15 minutes).
const queueTweetWithExpiry = function(expiryInMS) {
  let queueTweet = async function(params) {
    let msgToTweet = extractText(params.message);
    let userId = params.message.user;
    postCache[userId] = {
      id: params.message.ts,
      content: msgToTweet,
      lastPostTime: new Date(),
      expiry: new Date(new Date().getTime() + expiryInMS)
    };
    return params;
  };

  return queueTweet;
}

// const checkTweetExpiry = async function(params) {
//   let now = new Date();
//   let userId = params.message.user;
//   let postExpiry = postCache[userId] && postCache[userId].expiry;
//     if (postExpiry) {
//       if (now > postExpiry) return;
//     }
//
//     return params;
// }

// checkRetweetPrefix validates that the message we want to tweet starts with :twitter: (or has a twitter url in it)
const checkRetweetOrSpecificPrefix = function(prefix) {
  const checkRetweetPrefix = async function(params) {
    // if (debugMode) {
    //   log.info(`DEBUG_MODE: skipping prefix check`);
    //   return params;
    // }

    if (!params.message.text) {
      log.info(`Message not found ignoring - message.type: ${params.message.subtype} user:${params.message.user}`);
      return;
    }

    if (params.message.text.startsWith(prefix)) {
      return params;
    }

    if (params.message.text.match(new RegExp(patternForTwitterUrl))) {
      return params;
    }

    log.info(`Message does not start with '${prefix}' or does not include retweet - ignoring: `, params.message.text.substring(0, 80));
    return;
  };

  return checkRetweetPrefix;
}

// const checkUserHasQueuedTweet = async function(params) {
//   let userId = params.message.user;
//   if (!postCache[userId] || postCache[userId] && postCache[userId].sent) return;
//
//   return params;
// }



////////////////////////////////////////////////////////
// Confirmation Pipeline
// All receive params:{context, body, payload, action, respond, ack, say, next}
////////////////////////////////////////////////////////

const checkForConfirmation = async function(params) {
  if (params.action.value === 'no') {
    await slackPostEphemeral(params.body.container.channel_id, params.body.user.id, 'Sounds good :+1:. I will ignore that.');
    delete postCache[params.body.user.id]; // allow another message to be queued
    return;
  }
  return params;
}

const checkForMessagesQueuedFromUser = async function(params) {
  let userId = params.body.user.id;
  if (!postCache[userId]) {
    await slackPostEphemeral(params.body.container.channel_id, params.body.user.id, 'Sorry :-(, could not find messages from you!');
    return;
  }
  return params;
}

const checkConfirmationOnLatestMessage = async function(params) {
  let userId = params.body.user.id;
  let postInfo = postCache[userId];
  let msgId = params.action.action_id.split('_')[1];
  if (postInfo.id !== msgId) {
    await slackPostEphemeral(params.body.container.channel_id, params.body.user.id, 'Received confirmation on old message - ignoring');
    return;
  }
  return params;
}
const registerConfirmation = async function(params) {
  let userId = params.body.user.id;
  let postInfo = postCache[userId];
  postInfo.confirmation = true;

  await slackPostEphemeral(params.body.container.channel_id, params.body.user.id, `Great! As soon as I get ${reactionCntForApproval} reactions on the post, I will tweet and let you know.`);

  await slackPost(params.body.container.channel_id, params.body.user.id, `Want to help <@${userId}> get his last message amplified on Twitter? Please vote it up and I will tweet it from the MegaMaker account.`);

  return params;
}


////////////////////////////////////////////////////////
// Event Pipeline
// All receive params:{context, body, payload, event, say, next}
////////////////////////////////////////////////////////

const checkIfConfirmed = async function(params) {
  let postInfo = postCache[params.event.item_user];
  if (!postInfo) {
    log.info('Reaction on post that was not found')
    return;
  }
  if (postInfo.id !== params.event.item.ts) {
    log.info('Reaction on post that was not confirmed')
    return;
  }
  return params;
}
const checkIfAlreadyTweeted = async function(params) {
  let postInfo = postCache[params.event.item_user];
  if (postInfo.tweeted) {
    log.info('Reaction on post that was already tweeted')
    return;
  }
  return params;
}

const checkIfReactionFromSameUser = async function(params) {
  if (debugMode) return params;
  if (params.event.item_user === params.event.user) return;
  return params;
}
const registerReaction = async function(params) {
  let postInfo = postCache[params.event.item_user];
  if (!postInfo.reactionCnt) postInfo.reactionCnt = 0;
  postInfo.reactionCnt++;
  log.info('Reaction count on message: ', postInfo.reactionCnt);
  return params;
}
const checkIfReactionThreshold = async function(params) {
  let postInfo = postCache[params.event.item_user];
  if (postInfo.reactionCnt<reactionCntForApproval) {
    return;
  }
  return params;
}
const tweet = async function(params) {
  let userId = params.event.item_user;
  let postInfo = postCache[userId];

  try{
    await slackPostEphemeral(params.event.item.channel, params.event.item_user, `Hey <@${userId}>! - We got enough reactions. I am going ahead and tweeting: ${postInfo.content}`);
  } catch (err) {
    log.error('Posting to slack!!!', err);
  }

  let tweetRet;
  if (!debugMode) {
    try {
      var tweetMatch = postInfo.content.match(new RegExp(patternForTwitterUrl));
      // returns [0: tweet url, 1: tweet id]

      if (tweetMatch && postInfo.content.length == tweetMatch[0].length) {
        // pure retweet
        var tweetId = tweetMatch[1];
        tweetRet = await twitterClient.post(`statuses/retweet/${tweetId}`, {});
      } else {
        var twitterMsg = {
          status: postInfo.content
        };
        if (tweetMatch && postInfo.content.length == tweetMatch.index + tweetMatch[0].length) {
          // tweet with text (no text after tweet)
          twitterMsg.status = twitterMsg.status.substring(0, tweetMatch.index).trim();
          twitterMsg.attachment_url = tweetMatch[0];
        }
        tweetRet = await twitterClient.post('statuses/update', twitterMsg);
      }
    } catch (err) {
      log.error('Posting to twitter!!!', err);
    }
  } else {
    tweetRet = { status: 'DEBUG_MODE: did not really send' };
  }
  log.info(`Tweeted: ${postInfo.content} - Received: `, tweetRet);

  postCache[userId].tweeted = true;
  return params;
}
// exists for testing
const forceTweet = async function(txt) {
  var params = {
    event: {
      item_user: 'FAKE_ID'
    }
  }
  postCache['FAKE_ID'] = {
    content: txt
  };
  await tweet(params)
}

////////////////////////////////////////////////////////
// Generic Pipeline
////////////////////////////////////////////////////////

const printDbg = async function(params) {
  if (params.message) {
    log.info('Debug - message:', params.message);
    return params;
  }
  if (params.action) log.info('Debug - action:', params.action);
  if (params.event) log.info('Debug - event:', params.event);
  return params;
}

// Hook up the pipelines
const processPipe = async function(pipeName, pipe, params) {
  log.info(`==> [${pipeName}] Received notification`);

  for (let processor of pipe) {
    log.info(`==> [${pipeName}] Processing with processor: ${processor.name}`)
    params = await processor(params);
    if (!params) {
      log.info(`<== [${pipeName}] Finished processing`)
      return;
    }
  }
  log.info(`<== [${pipeName}] Finished processing`)
}


const messagePipeline = [
  filterChannelJoins,
  checkRetweetOrSpecificPrefix(msgTxtForTweeting),
  checkUserPostLimits(userPostLimit),
  queueTweetWithExpiry(tweetWithoutApprovalLimit),
  confirmMsgForTweet,
  printDbg
];

app.message(async (params) => {
  await processPipe('message', messagePipeline, params);
});


const tweetConfirmationPipeline = [
  checkForConfirmation,
  checkForMessagesQueuedFromUser,
  checkConfirmationOnLatestMessage,
  registerConfirmation,
  printDbg
];

app.action(/tweetConfirmation.*/, async (params) => {
  params.ack();
  await processPipe('tweetConfirmation', tweetConfirmationPipeline, params);
});


const reactionAddedPipeline = [
  checkIfConfirmed,
  checkIfAlreadyTweeted,
  checkIfReactionFromSameUser,
  registerReaction,
  checkIfReactionThreshold,
  tweet,
  printDbg
];

app.event('reaction_added', async (params) => {
  await processPipe('reactionAdded', reactionAddedPipeline, params);
});


// Start the app
(async () => {
  const appPort = process.env.PORT || 3000;
  await app.start(appPort);

  log.info(`App is running at ${appPort}`);
})();
