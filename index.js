const { App } = require('@slack/bolt');
const twitter = require('twitter');

const msgTxtForTweeting = ':twitter:'
const reactionCntForApproval = 3

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
let slackPostEphemeral = async (channel, user, msgToSend, blocks) => {
  console.log(`ephemerally posting: ${msgToSend}`);
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
  let msgToTweet = params.message.text;
  msgToTweet = msgToTweet.replace(new RegExp(msgTxtForTweeting, 'g'),'')

  let notifyTxt = 'Want me to tweet?'
  let msgToSend = `Hey there <@${params.message.user}>! - I can tweet that for you.`;
  let prompt = `Shall I go ahead and tweet: '${msgToTweet}'?`;

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
const queueTweetWithExpiry = function(expiryInMS = 1000 * 60 * 15) {
  let queueTweet = async function(params) {
    let msgToTweet = params.message.text;
    msgToTweet = msgToTweet.replace(new RegExp(msgTxtForTweeting, 'g'),'')
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

// checkPrefix validates that the message we want to tweet starts with :twitter:
const checkSpecificPrefix = function(prefix) {
  const checkPrefix = async function(params) {
    let msgToTweet = params.message.text;

    if (debugMode) {
      console.log(`DEBUG_MODE: skipping prefix check`);
      return params;
    }

    if (!msgToTweet.startsWith(prefix)) {
      console.log(`Message does not start with ${prefix}, ignoring`);
      return;
    }

    return params;
  };

  return checkPrefix;
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

  await slackPostEphemeral(params.body.container.channel_id, params.body.user.id, `Great! I will tweet and let you know as soon as I get ${reactionCntForApproval} reactions on the posts.`);

  return params;
}


////////////////////////////////////////////////////////
// Event Pipeline
// All receive params:{context, body, payload, event, say, next}
////////////////////////////////////////////////////////

const checkIfConfirmed = async function(params) {
  let postInfo = postCache[params.event.item_user];
  if (!postInfo) {
    console.log('Reaction on post that was not found')
    return;
  }
  if (postInfo.id !== params.event.item.ts) {
    console.log('Reaction on post that was not confirmed')
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
  console.log('Reaction count on message: ', postInfo.reactionCnt);
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
  let msgId = params.event.item.ts;
  let userId = params.event.item_user;
  let postInfo = postCache[userId];

  await slackPostEphemeral(params.event.item.channel, params.event.item_user, `Hey <@${params.message.user}>! - We got enough reactions. I am going ahead and tweeting: ${postInfo.content}`);

  let tweetRet;
  if (!debugMode) {
    tweetRet = await twitterClient.post('statuses/update', {status: postInfo.content});
  } else {
    tweetRet = { status: 'DEBUG_MODE: did not really send' };
  }
  console.log(`Tweeted: ${postInfo.content} - Received: `, tweetRet);

  delete postCache.userId;
  return params;
}

////////////////////////////////////////////////////////
// Generic Pipeline
////////////////////////////////////////////////////////

const printDbg = async function(params) {
  if (params.message) {
    console.log('Debug - message:', params.message);
    return params;
  }
  if (params.action) console.log('Debug - action:', params.action);
  if (params.event) console.log('Debug - event:', params.event);
  return params;
}

// Hook up the pipelines
const processPipe = async function(pipeName, pipe, params) {
  console.log(`==> [${pipeName}] Received notification`);

  for (let processor of pipe) {
    console.log(`==> [${pipeName}] Processing with processor: ${processor.name}`)
    params = await processor(params);
    if (!params) {
      console.log(`<== [${pipeName}] Finished processing`)
      return;
    }
  }
  console.log(`<== [${pipeName}] Finished processing`)
}


const messagePipeline = [
  filterChannelJoins,
  checkSpecificPrefix(msgTxtForTweeting),
  checkUserPostLimits(1000 * 60 * 1), // 1 min
  queueTweetWithExpiry(1000 * 60 * 15), // 15 min
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

  console.log(`App is running at ${appPort}`);
})();
