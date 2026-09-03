/* Renders the Physiodle header on the static pages (faq, terms, privacy).
   The styling comes from header.css, the same file the game uses, so the two
   cannot drift. Leaderboard, Friends and the rest are modals that only exist on
   the game page, so here they link back to it with ?open=, which index.html
   picks up and opens on arrival. */
(function () {
  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text) n.textContent = text;
    return n;
  }
  function link(label, href, cls) {
    const a = el('a', cls || 'header-btn', label);
    a.href = href;
    return a;
  }

  // Same-origin, so the game's stored username is readable here.
  let username = null;
  try { username = localStorage.getItem('physiodle_username'); } catch (e) { /* private mode */ }

  const header = el('header');

  const top = el('div', 'header-top');
  const home = el('a', 'header-left');
  home.href = '/';
  home.setAttribute('aria-label', "Back to today's puzzle");
  const icon = document.createElement('img');
  icon.className = 'logo-icon logo-icon-img';
  icon.src = '/favicon-96.png';
  icon.alt = '';
  icon.width = 28; icon.height = 28;
  home.appendChild(icon);
  home.appendChild(el('span', 'logo-text', 'Physiodle'));
  top.appendChild(home);

  const right = el('div', 'header-right');
  right.appendChild(link('Leaderboard', '/?open=leaderboard'));
  right.appendChild(link('Archive', '/?open=archive'));
  const account = link('', username ? '/?open=account' : '/?open=signin');
  account.id = 'accountBtn';
  account.appendChild(el('span', null, username || 'Sign In'));
  right.appendChild(account);
  top.appendChild(right);
  header.appendChild(top);

  const row2 = el('div', 'header-row2');
  const row2right = el('div', 'header-row2-right');
  row2right.appendChild(link('Friends', '/?open=friends'));
  const reminder = link('', '/?open=reminder');
  const rIcon = document.createElement('img');
  rIcon.className = 'app-icon';
  rIcon.src = '/favicon-32.png';
  rIcon.alt = '';
  rIcon.width = 14; rIcon.height = 14;
  reminder.appendChild(rIcon);
  reminder.appendChild(el('span', null, 'Daily reminder'));
  row2right.appendChild(reminder);
  row2.appendChild(row2right);
  header.appendChild(row2);

  document.body.insertBefore(header, document.body.firstChild);
})();
