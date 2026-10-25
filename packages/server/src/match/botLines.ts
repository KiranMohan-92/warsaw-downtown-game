import type { BotPersonalityId } from '@wd/shared';

/**
 * What a bot can say, by trigger and personality (`botChatter.ts` picks from these). Rusher =
 * cocky and loud, flanker = sly, anchor = dry and deadpan, marksman = smug. PG-13 trash talk:
 * no slurs, hate, sexual content, real people, other games or brands. English with the odd light
 * Polish word (spoko = cool, kurczę = darn, masakra = a mess, na razie = see you).
 *
 * `{them}` is the other player in the moment: the victim of a kill, the killer for a death or
 * a camping callout, the player whose quick chat a bot answers. Triggers without another player
 * (`NO_OTHER`) never use it (a test checks).
 */
export const CHAT_TRIGGERS = [
  'matchStart',
  'kill',
  'headshot',
  'streak',
  'revenge',
  'leaderKill',
  'death',
  'closeCall',
  'camped',
  'win',
  'lose',
  'replyTaunt',
  'replyPraise',
  'replyCallout',
  'replyTruce',
] as const;
export type ChatTrigger = (typeof CHAT_TRIGGERS)[number];

/** Triggers with nobody else in the moment: their lines never say `{them}`. */
export const NO_OTHER: readonly ChatTrigger[] = ['matchStart', 'closeCall', 'win', 'lose'];

export type LinePool = Record<BotPersonalityId, readonly string[]>;

export const BOT_LINES: Record<ChatTrigger, LinePool> = {
  matchStart: {
    rusher: [
      "Doors open. I'm already running.",
      'Last one to a fight buys pierogi.',
      "Warm-up's over. I skipped it anyway.",
      'Point me at someone. Anyone.',
      "Coffee in, brakes off. Let's go!",
    ],
    flanker: [
      "I'll be around. Behind you, mostly.",
      "Don't mind me. Nobody ever does.",
      'So many side doors on this map. Lovely.',
      'Quiet start. I like quiet.',
    ],
    anchor: [
      'In position. Not moving.',
      'I found a good wall. It found me back.',
      'Match started. Noted.',
      "Bring it to me. I'll be here.",
    ],
    marksman: [
      'Optics clean. Wind calm. You lot, less so.',
      'Long sightlines today. Lucky me.',
      "I've already ranged this whole square.",
      'Settle in. This will be precise.',
    ],
  },
  kill: {
    rusher: [
      'Too slow, {them}!',
      'Ran right through you, {them}.',
      'Next!',
      'That is what charging looks like, {them}.',
      "Spoko. Who's next?",
      'Blink and you miss me, {them}. You blinked.',
    ],
    flanker: [
      'Peekaboo, {them}.',
      'Wrong way, {them}. I was the other way.',
      'You never check your left, {them}.',
      "Shh. You'll be fine. Eventually.",
      'Came in the side door, {them}. Hope that was okay.',
      'Missed me? You did. Completely.',
    ],
    anchor: [
      '{them} walked into my spot.',
      "That's my corner, {them}.",
      'Predictable.',
      'One less.',
      'Delivered to my door. Thank you, {them}.',
      'Held. Next.',
    ],
    marksman: [
      'Clean. Textbook, really.',
      '{them}, you were standing in my lane.',
      'Simple geometry, {them}.',
      'Mathematically, that was inevitable.',
      'I had you ranged before you spawned, {them}.',
      "Don't take it personally, {them}. Take it statistically.",
    ],
  },
  headshot: {
    rusher: [
      'Right between the visors, {them}!',
      'HEADSHOT. Say it with me.',
      "Didn't even aim. Okay, I aimed a little.",
      'Bonk. Lights out, {them}.',
    ],
    flanker: [
      'Your helmet had a blind spot, {them}.',
      'Heads up! Oh. Too late.',
      'Thinking cap: off.',
      'Quietly, right above the collar.',
    ],
    anchor: [
      'Head. Noted.',
      'That one went where I put it.',
      'Helmet check failed, {them}.',
      'Efficient.',
    ],
    marksman: [
      'Headshot. Was there ever any doubt?',
      "I could do that blindfolded. I won't. But I could.",
      'Your hitbox is mostly forehead, {them}.',
      'Ten out of ten, {them}. For me.',
    ],
  },
  streak: {
    rusher: [
      'UNSTOPPABLE! Probably!',
      'Who ordered the combo meal?',
      "I'm on fire and I didn't even bring a lighter.",
      "Line up, I'll take you all at once.",
    ],
    flanker: [
      'Two for one. I love a bargain.',
      'They never see the second one coming.',
      'Busy little fox tonight.',
      'And another one slips away.',
    ],
    anchor: [
      'The wall is winning.',
      'Same corner. Different customers.',
      'Queue forming. Please wait your turn.',
      'Still here. Still counting.',
    ],
    marksman: [
      'A pattern is emerging, and it is me.',
      'Streak intact. As forecast.',
      "Somebody check the scoreboard. Actually, don't.",
      'Consistency is a skill, children.',
    ],
  },
  revenge: {
    rusher: [
      'Payback, {them}! With interest!',
      'Remember me, {them}? I remembered you.',
      'Told you I would come back loud.',
      'Round two goes to me, {them}.',
    ],
    flanker: [
      'I never forget a face, {them}. Especially from behind.',
      'Revenge is a dish best served from the side.',
      "We're even, {them}. For now.",
      "Thought I'd left, {them}? Cute.",
    ],
    anchor: [
      'Debt settled, {them}.',
      'That evens it.',
      'I waited. It paid off.',
      'Account closed, {them}.',
    ],
    marksman: [
      'Balance restored, {them}.',
      'I kept a note, {them}. I always keep notes.',
      'Revenge, calibrated.',
      "Your lucky shot earlier? This one wasn't luck.",
    ],
  },
  leaderKill: {
    rusher: [
      "Crown's mine now, {them}!",
      'Top dog? Not anymore, {them}.',
      'Knocked the leader flat. Feels good.',
      'Big name, small finish, {them}.',
    ],
    flanker: [
      'Heavy is the head, {them}. Lighter now.',
      'Stole the spotlight. And your lunch, {them}.',
      'Leader down. Nobody saw who. (It was me.)',
      'Even the leader has to check corners, {them}.',
    ],
    anchor: [
      'Leader removed.',
      'Scoreboard adjusted, {them}.',
      'First place came to my wall.',
      'Top spot fell over. Noted.',
    ],
    marksman: [
      'Dethroned, {them}. Politely.',
      'The scoreboard has been corrected.',
      'Took out the favourite. Calculated.',
      '{them} was carrying. Was.',
    ],
  },
  death: {
    rusher: [
      'Lag! It was lag! Probably.',
      'I let you have that one, {them}.',
      "Okay {them}, that one's going in my diary.",
      'Kurczę. Respawning angrier.',
      'I was going so fast I forgot to dodge.',
      "Fine, {them}. Rematch in three seconds. Don't move.",
    ],
    flanker: [
      'I was just scouting the afterlife.',
      'Nice one, {them}. I was distracted. By your luck.',
      'Tactical nap. Back soon.',
      'Lucky, {them}. Very lucky.',
      'You found me, {them}. Nobody finds me.',
      "That wasn't the plan. The plan was better.",
    ],
    anchor: [
      'Unfortunate.',
      'My wall betrayed me.',
      'Noted, {them}.',
      'That will not happen twice.',
      'Corner compromised.',
      'Hm. Annoying.',
    ],
    marksman: [
      "Statistically, that shouldn't have worked, {them}.",
      'My scope fogged up. Obviously.',
      'I was recalibrating, {them}. Rude.',
      'Lucky spray beats skill. Sometimes.',
      'That is going in my margin of error.',
      'I let you get close, {them}. Strategy. Clearly.',
    ],
  },
  closeCall: {
    rusher: [
      'Ha! One HP is still HP!',
      'Nearly! Not quite! Never quite!',
      'That tickled. A lot.',
      'Patched up with tape and attitude.',
    ],
    flanker: [
      'Ooh. Too close. Love it.',
      'Slipped right through that one.',
      'Still breathing. Barely, but stylishly.',
      'You missed all the important bits.',
    ],
    anchor: [
      'Damaged. Operational.',
      'Still standing. Slightly less.',
      'Low health. High resolve.',
      'Cracked. Not broken.',
    ],
    marksman: [
      'A margin of error I can live with.',
      'Survived on a sliver. Exactly as planned.',
      "I'll just pretend that was intentional.",
      'Low health is a lifestyle choice.',
    ],
  },
  camped: {
    rusher: [
      'Come out and fight, {them}!',
      'Paying rent in that corner, {them}?',
      'Camping is for holidays, {them}!',
      "{them}, you've sat there so long you're part of the map.",
    ],
    flanker: [
      "Cosy spot, {them}. I'll remember where it is.",
      'Found your nest, {them}. Coming back for it.',
      '{them} sat still so long I thought you were a crate.',
      'Lovely hiding place. Shame I know it now.',
    ],
    anchor: [
      'Respect the corner, {them}.',
      "That's an anchor's job, {them}. Get your own wall.",
      'Good position. I hate it.',
      'Patient. Annoying. Effective, {them}.',
    ],
    marksman: [
      '{them} has been in that corner for a geological era.',
      'Bold strategy, {them}: become furniture.',
      "You've put down roots, {them}. Like a tree.",
      'Camping detected. Coordinates logged, {them}.',
    ],
  },
  win: {
    rusher: [
      'Told you. Fastest feet in Warsaw!',
      'GG! Mostly G for me.',
      'Winner winner, pierogi dinner!',
      "Run it back! I'm still warm!",
    ],
    flanker: [
      'Nobody saw me coming. Again.',
      'Slipped in, took the win, slipped out.',
      "GG. I'll be just around the corner. Always.",
      'Clever beats loud. Every time.',
    ],
    anchor: [
      'Held the line. Won.',
      'GG. The wall thanks you.',
      'Patience pays.',
      'Victory. As expected.',
    ],
    marksman: [
      'Precision wins matches. Write that down.',
      'GG. My aim sends its regards.',
      'First place, calculated to the decimal.',
      'Another match, another clean scope.',
    ],
  },
  lose: {
    rusher: [
      "GG. I'll get you next round. All of you!",
      'Rematch! Right now! Please!',
      'I was warming up. That was the warm-up.',
      'Masakra. Running it back.',
    ],
    flanker: [
      'I was playing the long game. Very long.',
      'GG. I let you think you won.',
      "Next time I'm coming from a direction you don't own.",
      'Losing is just flanking the scoreboard.',
    ],
    anchor: [
      'GG. Recalibrating wall.',
      'Lost. Noted.',
      'The wall will rise again.',
      "GG. Next match, I don't move at all.",
    ],
    marksman: [
      'GG. The wind was clearly against me.',
      'My numbers were excellent. My score, less so.',
      "I'll be filing a complaint with the scoreboard.",
      "Statistically I'm due. Next match.",
    ],
  },
  replyTaunt: {
    rusher: [
      "Is that all? I'm just getting started, {them}!",
      'Big words, {them}. Come say them up close.',
      "Oh, it's on now, {them}.",
      'Talk less, run at me more!',
    ],
    flanker: [
      "Keep talking, {them}. I'll find you by the sound.",
      "Bold. I'll be seeing you. You won't be seeing me.",
      'Sure, {them}. Check behind you.',
      'Noted, {them}. Very noted.',
    ],
    anchor: [
      'Come and get it, {them}.',
      'Words. Bullets work better.',
      "I'm right here, {them}.",
      'Sure.',
    ],
    marksman: [
      'Your confidence is adorable, {them}.',
      'Talk is cheap. My ammo is cheaper.',
      "I'd answer, {them}, but you're in my scope.",
      'Taunting the one with the scope. Brave, {them}.',
    ],
  },
  replyPraise: {
    rusher: [
      "Thanks! I'm kind of amazing.",
      'I know, {them}. I know.',
      'Appreciated! Still coming for you though.',
      'GG, {them}! Good game, great me.',
    ],
    flanker: [
      "Why thank you, {them}. I'll still flank you.",
      "Flattery won't save you. But it's nice.",
      'Aw. You noticed me for once.',
      'Spoko, {them}.',
    ],
    anchor: ['Thanks.', 'Appreciated, {them}.', 'GG.', 'Kind. Still not moving.'],
    marksman: [
      'Naturally. But thank you, {them}.',
      'Your taste in shots is excellent.',
      'Good game indeed. Mostly my good.',
      'I accept your praise, {them}. And your respawn.',
    ],
  },
  replyCallout: {
    rusher: [
      "Behind who? I'm behind EVERYONE eventually!",
      'Reloading? Perfect timing. For me.',
      'Callouts in free-for-all? Cute, {them}!',
      'I heard that! Coming!',
    ],
    flanker: [
      'Thanks for the intel, {them}. Very generous.',
      'Reloading, you say? Interesting.',
      "We're all enemies here, {them}. But I like the honesty.",
      "I'll go check. Quietly.",
    ],
    anchor: ['Noted.', 'Copy, {them}.', 'Good to know.', "I'll watch it."],
    marksman: [
      'Information received. Weaponised.',
      "Thanks, {them}. I'll put it to good use. On you.",
      "Reloading? I'm aiming.",
      'Free intel is my favourite kind.',
    ],
  },
  replyTruce: {
    rusher: [
      'Truce? Never heard of it!',
      'Sure, {them}. Truce starts… never.',
      'Truce accepted! (It is not.)',
      "I'll think about it while I chase you.",
    ],
    flanker: [
      'Of course, {them}. Turn around for me?',
      'A truce. How charming. How brief.',
      'Deal. Pinky promise. Fingers crossed.',
      "Truce until it isn't, {them}.",
    ],
    anchor: ['No.', 'Denied, {them}.', 'Truce declined. Politely.', "The wall doesn't negotiate."],
    marksman: [
      "I'll consider it, {them}. Considered. No.",
      'Truce? You are already in my scope.',
      "Let's call it a ceasefire. For about two seconds.",
      'Truce noted. Ignored, but noted.',
    ],
  },
};
