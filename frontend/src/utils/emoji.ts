/** Built-in emoji set (Unicode, rendered by the OS font). Names power search in both languages. */
export interface EmojiCategory {
  id: string;
  label: string;
  emoji: [string, string][]; // [char, search keywords]
}

export const EMOJI: EmojiCategory[] = [
  {
    id: 'smileys',
    label: 'Смайлы',
    emoji: [
      ['😀', 'grin улыбка'], ['😃', 'smile радость'], ['😄', 'happy счастье'], ['😁', 'beam'], ['😆', 'laugh смех'], ['😅', 'sweat пот'],
      ['🤣', 'rofl ржу'], ['😂', 'joy слёзы смех'], ['🙂', 'slight'], ['🙃', 'upside'], ['😉', 'wink подмигнуть'], ['😊', 'blush'],
      ['😇', 'angel ангел'], ['🥰', 'love любовь'], ['😍', 'heart eyes'], ['🤩', 'star'], ['😘', 'kiss поцелуй'], ['😋', 'yum вкусно'],
      ['😛', 'tongue язык'], ['😜', 'wink tongue'], ['🤪', 'crazy'], ['🤨', 'raised brow'], ['🧐', 'monocle'], ['🤓', 'nerd ботан'],
      ['😎', 'cool крутой'], ['🥳', 'party праздник'], ['😏', 'smirk'], ['😒', 'unamused'], ['😞', 'sad грусть'], ['😔', 'pensive'],
      ['😟', 'worried'], ['😕', 'confused'], ['🙁', 'frown'], ['😣', 'persevere'], ['😫', 'tired устал'], ['😩', 'weary'],
      ['🥺', 'pleading'], ['😢', 'cry плакать'], ['😭', 'sob рыдать'], ['😤', 'triumph'], ['😠', 'angry злой'], ['😡', 'rage ярость'],
      ['🤬', 'swear'], ['🤯', 'mind blown взрыв'], ['😳', 'flushed'], ['🥵', 'hot жарко'], ['🥶', 'cold холодно'], ['😱', 'scream крик'],
      ['😨', 'fear страх'], ['🤗', 'hug обнять'], ['🤔', 'thinking думаю'], ['🤭', 'oops'], ['🤫', 'shush тихо'], ['🤥', 'lie'],
      ['😶', 'no mouth'], ['😐', 'neutral'], ['😬', 'grimace'], ['🙄', 'eye roll'], ['😴', 'sleep сон'], ['🤤', 'drool'],
      ['😷', 'mask маска'], ['🤒', 'sick болею'], ['🤢', 'nausea'], ['🤮', 'vomit'], ['🤧', 'sneeze'], ['🥴', 'woozy'],
      ['😵', 'dizzy'], ['🤠', 'cowboy'], ['😈', 'devil'], ['👿', 'imp'], ['💀', 'skull череп'], ['☠️', 'skull bones'],
      ['💩', 'poop'], ['🤡', 'clown клоун'], ['👻', 'ghost призрак'], ['👽', 'alien'], ['🤖', 'robot робот'], ['😺', 'cat кот'],
    ],
  },
  {
    id: 'people',
    label: 'Жесты',
    emoji: [
      ['👋', 'wave привет'], ['🤚', 'raised back'], ['✋', 'hand рука'], ['🖖', 'vulcan'], ['👌', 'ok окей'], ['🤌', 'pinched'],
      ['✌️', 'victory'], ['🤞', 'crossed удача'], ['🤟', 'love you'], ['🤘', 'rock'], ['🤙', 'call me'], ['👈', 'left'],
      ['👉', 'right'], ['👆', 'up'], ['👇', 'down'], ['☝️', 'point'], ['👍', 'thumbs up like да'], ['👎', 'thumbs down нет'],
      ['✊', 'fist'], ['👊', 'punch'], ['🤛', 'left fist'], ['🤜', 'right fist'], ['👏', 'clap аплодисменты'], ['🙌', 'raise hands'],
      ['👐', 'open hands'], ['🤲', 'palms'], ['🤝', 'handshake рукопожатие'], ['🙏', 'pray спасибо'], ['✍️', 'write'], ['💪', 'muscle сила'],
      ['🧠', 'brain мозг'], ['👀', 'eyes глаза'], ['👁️', 'eye'], ['👅', 'tongue'], ['🫡', 'salute'], ['🫠', 'melt'],
    ],
  },
  {
    id: 'hearts',
    label: 'Символы',
    emoji: [
      ['❤️', 'heart сердце'], ['🧡', 'orange heart'], ['💛', 'yellow heart'], ['💚', 'green heart'], ['💙', 'blue heart'], ['💜', 'purple heart'],
      ['🖤', 'black heart'], ['🤍', 'white heart'], ['💔', 'broken heart'], ['💕', 'hearts'], ['💯', '100 сто'], ['🔥', 'fire огонь'],
      ['✨', 'sparkles блеск'], ['⭐', 'star звезда'], ['🌟', 'glowing star'], ['💥', 'boom'], ['💫', 'dizzy star'], ['💤', 'zzz'],
      ['✅', 'check галочка'], ['❌', 'cross крест'], ['❗', 'exclamation'], ['❓', 'question вопрос'], ['⚠️', 'warning'], ['🚫', 'no'],
      ['🔔', 'bell'], ['🎵', 'music музыка'], ['💬', 'speech'], ['💭', 'thought'], ['🆗', 'ok'], ['🆕', 'new'],
    ],
  },
  {
    id: 'activities',
    label: 'Активности',
    emoji: [
      ['🎮', 'game игра'], ['🕹️', 'joystick'], ['🎲', 'dice'], ['🎯', 'target'], ['🏆', 'trophy кубок'], ['🥇', 'gold'],
      ['⚽', 'soccer футбол'], ['🏀', 'basketball'], ['🎾', 'tennis'], ['🏐', 'volleyball'], ['🎸', 'guitar гитара'], ['🎧', 'headphones'],
      ['🎤', 'mic микрофон'], ['🎬', 'movie кино'], ['📷', 'camera'], ['💻', 'laptop код'], ['⌨️', 'keyboard'], ['🖥️', 'desktop'],
      ['📱', 'phone'], ['🎉', 'tada праздник'], ['🎊', 'confetti'], ['🎁', 'gift подарок'], ['🎂', 'cake торт'], ['🚀', 'rocket ракета'],
    ],
  },
  {
    id: 'nature',
    label: 'Природа и еда',
    emoji: [
      ['🐶', 'dog собака'], ['🐱', 'cat кот'], ['🦊', 'fox лиса'], ['🐻', 'bear'], ['🐼', 'panda'], ['🐸', 'frog'],
      ['🐧', 'penguin'], ['🦄', 'unicorn'], ['🐝', 'bee'], ['🌸', 'blossom'], ['🌈', 'rainbow радуга'], ['☀️', 'sun солнце'],
      ['🌙', 'moon луна'], ['❄️', 'snow снег'], ['🌊', 'wave'], ['🍕', 'pizza пицца'], ['🍔', 'burger'], ['🍟', 'fries'],
      ['🍣', 'sushi'], ['🍩', 'donut'], ['🍪', 'cookie'], ['☕', 'coffee кофе'], ['🍵', 'tea чай'], ['🍺', 'beer пиво'],
    ],
  },
];

export const QUICK_REACTIONS = ['👍', '❤️', '😂', '🔥', '😮', '😢'];

export function searchEmoji(q: string): string[] {
  const t = q.trim().toLowerCase();
  if (!t) return [];
  return EMOJI.flatMap((c) => c.emoji.filter(([, k]) => k.includes(t)).map(([e]) => e)).slice(0, 80);
}
