// EmojiPicker.jsx — Built-in emoji picker, no external deps
import { useState, useRef, useEffect } from "react";
import { useTranslation } from "../utils/i18n.jsx";

const EMOJI_DATA = [
  { icon: "😀", key: "emoji.cat_smileys", emojis: ["😀","😃","😄","😁","😆","😅","🤣","😂","🙂","🙃","😉","😊","😇","🥰","😍","🤩","😘","😋","😛","😜","🤪","😝","🤑","🤗","🤔","🤐","😐","😑","😶","😏","😒","🙄","😬","🤥","😌","😔","😪","😴","😷","🤒","🤕","🤢","🤮","🤧","🥵","🥶","😵","🤯","🤠","🥳","😎","🤓","🧐","😕","😟","🙁","☹","😮","😲","😳","🥺","😦","😧","😨","😰","😥","😢","😭","😱","😖","😣","😞","😓","😩","😫","🥱","😤","😡","😠","🤬","😈","👿","💀","💩","🤡","👹","👺","👻","👽","👾","🤖"] },
  { icon: "👋", key: "emoji.cat_gestures", emojis: ["👋","🤚","✋","👌","✌","🤞","🤟","🤘","🤙","👈","👉","👆","👇","☝","👍","👎","✊","👊","🤛","🤜","👏","🙌","👐","🤲","🤝","🙏","✍","💪","👀","👅","👄"] },
  { icon: "❤️", key: "emoji.cat_hearts", emojis: ["❤️","🧡","💛","💚","💙","💜","🖤","🤍","🤎","💔","❣️","💕","💞","💓","💗","💖","💘","💝","💯","💢","💥","💫","💦","💨","💬","💭","💤"] },
  { icon: "🎉", key: "emoji.cat_activity", emojis: ["🎉","🎊","🎈","🎁","🎀","🏆","🥇","🥈","🥉","🎯","🎱","🎮","🕹","🎰","🎲","🧩","🧸","⚽","🏀","🏈","⚾","🥎","🏐","🏉","🎾","🏸","🥊","🥋","⛸","🛷","🛹"] },
  { icon: "🐶", key: "emoji.cat_animals", emojis: ["🐶","🐱","🐭","🐹","🐰","🦊","🐻","🐼","🐨","🐯","🦁","🐮","🐷","🐸","🐵","🙈","🙉","🙊","🐔","🐧","🐦","🦆","🦅","🦉","🦇","🐺","🐴","🦄","🐝","🦋","🐌","🐞","🐜","🦟","🦗","🕷","🦂","🐢","🐍","🦎","🐙","🐬","🐳","🐋","🦈","🐊","🐘","🦒","🐕","🐈","🐇","🦔"] },
  { icon: "🍕", key: "emoji.cat_food", emojis: ["🍕","🍔","🌭","🍟","🌮","🌯","🥗","🍝","🍜","🍣","🍱","🥟","🍤","🥚","🍳","🥞","🧇","🥓","🥩","🍗","🍖","🌽","🥦","🥕","🥐","🍞","🧀","🍰","🎂","🧁","🍩","🍪","🍫","🍬","🍭","🍿","☕","🍵","🧃","🥤","🧋","🍺","🍻","🥂","🍷","🥃","🍹","🍾"] },
  { icon: "✈️", key: "emoji.cat_travel", emojis: ["✈️","🚀","🛸","🚁","🚂","🚄","🚗","🚕","🚌","🚎","🚑","🚒","🚓","🏎","🏍","🛵","🚲","🛴","🛹","⛵","🚢","🛥","🏖","🏝","🏕","🗺","🌍","🌎","🌏","🗼","🏰","🏯","🗽","🗿","⛩"] },
  { icon: "💡", key: "emoji.cat_symbols", emojis: ["💡","🔥","❄","⭐","🌟","✨","💥","🌈","🌊","⚡","☔","🌀","🌪","🔑","🔒","🔓","🔔","🔇","🔊","🎵","🎶","📱","💻","🖥","📷","📸","📹","🎥","📺","🔭","🔬","💊","🔧","🔨","⚒","🛠","🧲","🕯","🔦","🪄","🎭","🎨","🖌","✏","📝","📚","📖","📌","📍","🗑","💰","💳","💎","🏷"] },
];

export default function EmojiPicker({ onSelect, onClose }) {
  const { t } = useTranslation();
  const CATEGORIES = EMOJI_DATA.map(c => ({ ...c, label: t(c.key) }));

  const [activeCat, setActiveCat] = useState(0);
  const [search, setSearch] = useState("");
  const ref = useRef(null);

  useEffect(() => {
    const handleClick = (e) => {
      if (ref.current && !ref.current.contains(e.target)) onClose();
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [onClose]);

  const allEmojis = CATEGORIES.flatMap(c => c.emojis);
  const displayEmojis = search ? allEmojis : CATEGORIES[activeCat].emojis;

  return (
    <div className="emoji-picker glass" ref={ref}>
      <div className="emoji-search">
        <input
          type="text"
          placeholder={t('emoji.search')}
          value={search}
          onChange={e => setSearch(e.target.value)}
          autoFocus
          className="emoji-search-input"
        />
      </div>
      <div className="emoji-cats">
        {CATEGORIES.map((cat, i) => (
          <button
            key={i}
            className={"emoji-cat-btn " + (activeCat === i && !search ? "active" : "")}
            onClick={() => { setActiveCat(i); setSearch(""); }}
            title={cat.label}
            type="button"
          >
            {cat.icon}
          </button>
        ))}
      </div>
      <div className="emoji-grid">
        {displayEmojis.map((emoji, i) => (
          <button
            key={i}
            className="emoji-btn"
            onClick={() => onSelect(emoji)}
            type="button"
          >
            {emoji}
          </button>
        ))}
      </div>
    </div>
  );
}
