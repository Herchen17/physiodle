# Physiodle design-system, sandbox-auth and growth-foundation specification

Date: 9 September 2026  
Status: proposed for sandbox implementation  
Branch: `codex/apple-liquid-glass-sandbox`

## Objective

Turn the current iPhone-oriented redesign into a coherent Physiodle player experience that feels as though the visual system was present from the beginning, while retaining the existing vanilla web/PWA architecture. Make every player-facing state testable with synthetic local data, add a safe production-versus-sandbox comparison view, and implement the low-risk technical discoverability improvements identified in the growth audit.

Nothing in this specification deploys to Railway, reads or copies production user data, contacts users or communities, submits a search-engine property, purchases a domain, or creates an external listing.

## Scope

### Included

- Daily game and clue states.
- Welcome, sign-in, sign-up, password-reset and account experiences.
- Friends, leaderboard and archive.
- Win, loss, answer-summary, share and milestone states.
- Installation, notification reminder, feedback and sibling-game promotion.
- Toasts, loading, empty, success, warning and error states.
- FAQ, terms and privacy pages and their shared player navigation.
- Light and dark appearance, reduced motion/transparency, safe areas and responsive layouts.
- Synthetic sandbox users, games, friendships and archive history.
- A visual comparison page.
- Technical search/discoverability fixes and privacy-safe acquisition attribution.

### Explicitly excluded

- `admin.html` and `admin-v2.html`, which remain a separate operator-facing design system.
- Expo or React Native migration.
- Production database access or production-account authentication.
- Offline puzzle play.
- Publishing unreviewed clinical articles or condition pages.
- Deployment and external marketing actions.

## Selected approach

Use a shared CSS/HTML component contract inside the existing PWA. This is preferred over adding another override-only layer, which would compound the current 355 hardcoded colour references and 108 inline style attributes, and over a framework rewrite, which would add migration risk without improving the core daily-game loop.

The migration will be incremental but complete within the player-facing scope: introduce tokens and reusable component classes, move presentation out of inline styles where a surface is touched, and retain existing element IDs and JavaScript behaviour.

## Visual system

### Principles

- Clinical content remains opaque and prioritises legibility.
- Translucent material is reserved for floating navigation, controls and sheet headers.
- One teal accent and one neutral family define the product; status colours remain semantic.
- Typography and whitespace create hierarchy; boxes and borders are used only where they communicate grouping or state.
- Touch targets are at least 44 CSS pixels.
- The Home Screen PWA is the primary compact experience, while browser and desktop layouts remain first-class.

### Tokens

Extend the existing custom properties with:

- Colour: canvas, surface, elevated surface, material, primary/secondary/tertiary label, separator, accent and pressed accent, success, warning, danger, information, their tinted fills, focus ring, scrim and inverse text.
- Spacing: 4, 8, 12, 16, 20, 24 and 32 pixels.
- Type roles: large title, title, headline, body, callout, subheadline, footnote and caption using the system font stack.
- Shape: control, card and sheet radii.
- Elevation: control, floating bar and sheet shadows.
- Motion: fast control feedback and sheet presentation, disabled under reduced motion.
- Safe-area variables for top and bottom chrome.

### Reusable class contracts

- App chrome and compact tab bar.
- Filled, tinted, plain and destructive buttons; icon buttons retain a small glyph inside a 44-pixel hit area.
- Text field, select and validation message.
- Segmented control and tabs.
- Sheet/dialog and sticky sheet header.
- Grouped list, list row and stat tile.
- Status chip, toast and empty/loading/error state.
- Calendar day, leaderboard table and distribution bar.
- Promo popover and feedback chip.

### Surface migration

The game, result/share, authentication, account, friends, leaderboard, archive, install/reminder, feedback/love, milestone and sibling-promotion surfaces will use the shared contracts. Generated HTML created by JavaScript must use semantic classes rather than inline colour declarations.

FAQ, terms and privacy will load the same token layer and use a shared static-page header that matches the game shell. Their reading cards remain opaque. The admin pages will not load this layer.

## Interaction and accessibility

- Modal openings set `role="dialog"`, `aria-modal="true"` and an accessible title relationship.
- Opening a modal records the triggering control, moves focus into the modal and locks background scrolling.
- Tab focus remains inside the topmost modal.
- Escape and outside-click close only dismissible modals; focus returns to the trigger.
- Tabs expose selected state and keyboard navigation.
- Toasts use an appropriate live region and sit above the mobile dock and safe area.
- Colour is never the only marker of calendar, guess or result state.
- Layouts must not horizontally overflow at 320, 393, 641, 768, 900 or 1280 pixels.

## Sandbox authentication and fixtures

### Isolation

Sandbox mode is enabled only with an explicit environment flag. The seed command refuses to run unless:

- the database path resolves beneath `/tmp`;
- the environment is not production;
- sibling application URLs and secrets are absent; and
- a sandbox-only JWT secret is supplied.

Mail uses the JSON/log transport with an output beneath `/tmp`. Production credentials are expected not to work.

### Synthetic data

An idempotent seed command creates reserved `demo_*` users with `.example` email addresses and real password hashes. Fixtures cover:

- a populated profile with wins, losses, streaks and a guess distribution;
- a second friend with results;
- an incoming and an outgoing friend request;
- completed and unplayed archive dates; and
- global and friend leaderboard rows.

The sandbox displays a discreet local-only panel containing the demo username and password. Users can also create new temporary accounts through the real sign-up endpoint.

Tests obtain tokens through the real login endpoint. No token is preloaded into local storage.

### Auth corrections

- `/api/auth/me` returns `401` when a validly signed token references a missing user instead of dereferencing a null row and returning `500`.
- The client clears unusable local authentication state consistently.
- Sandbox reset creates a fresh database and avoids accumulated rate-limit state.
- Password reset and email confirmation are exercised through the local mail outbox without sending mail.

## Comparison view

Add `/compare.html` with labelled Current and Sandbox panes and phone, tablet and desktop controls.

Production sends `X-Frame-Options: SAMEORIGIN`, so it will not be proxied or embedded by bypassing its security policy. The Current pane uses matched, timestamped screenshots captured read-only from the production URL. The Sandbox pane is a live same-origin frame and remains interactive, including login and modal testing. Both panes share the selected viewport dimensions; scrolling is independent. A link opens the true production site in a separate tab when live interaction is required.

The comparison page and production screenshots are sandbox-only and carry `noindex`.

## Technical growth foundation

### Crawl and index control

- Replace the catch-all `200` homepage response with an explicit route policy and a real `404` for unknown non-API paths.
- Preserve intended app query-state URLs on `/`.
- Add `noindex,nofollow` to both admin HTML pages and `noindex` to sandbox comparison/demo pages.
- Include canonical public pages in the XML sitemap with accurate URLs; omit admin and sandbox pages.
- Keep `robots.txt` pointing to the sitemap. Do not use robots blocking as a substitute for `noindex`.

### Page metadata and semantics

- Use `lang="en-AU"` consistently.
- Give FAQ, terms and privacy unique descriptions and canonical URLs.
- Give the FAQ useful Open Graph and Twitter metadata.
- Make the visible game introduction the document H1 without turning the interface into a marketing landing page.
- Add a short evergreen explanation of the free daily physiotherapy clinical-reasoning game below the primary interaction.
- Add conservative JSON-LD describing a free browser-based educational web application. Do not add ratings or unsupported claims.

### Social preview

Create a branded 1200 × 630 non-spoiler social image using the new visual system. Configure Open Graph dimensions and `summary_large_image`. Daily result cards remain separate and never expose the answer in URL metadata.

### Loading performance

Fetch and render the daily puzzle independently of the autocomplete condition list. Load autocomplete data lazily, cache it with validators or a versioned long-lived asset, and preserve a useful typed-input loading/error state. No clinical data is removed.

### Acquisition measurement

Record first-touch `document.referrer` and allow-listed `utm_source`, `utm_medium` and `utm_campaign` values using the existing first-party analytics system. Track share-sheet open, copy, native share, X, Reddit and image download separately, plus the eventual referred sign-up. Do not add third-party advertising trackers. Update the privacy text before any production deployment.

## Growth work deliberately deferred

The following can be drafted locally after the foundation but require content/brand review or external authorisation before publishing:

- Evergreen physiotherapy clinical-reasoning and specialty landing pages.
- Student-society and educator outreach material.
- A measured Reddit feature-update post.
- Directory or PWA-store submissions.
- Search Console/Bing submissions.
- Purchasing or migrating to a custom domain.

Clinical educational copy will be marked for Lizzy’s review before publication.

## Verification

### Automated

- Browser tests at 320, 393, 641, 768, 900 and 1280 pixels in light and dark appearance.
- Reduced-motion and reduced-transparency fallbacks.
- No horizontal overflow and 44-pixel interactive targets.
- Every player-facing modal and generated state via deterministic fixtures.
- Keyboard focus trap, Escape, focus restoration and scroll locking.
- Signup, login, logout, missing-user token, password reset and confirmation.
- Populated and empty account, friend, leaderboard and archive states.
- Win/loss, sharing fallbacks, installation variants, reminder states and toast placement.
- True `404`, sitemap contents, metadata, canonical and JSON-LD checks.
- Puzzle rendering does not wait for autocomplete completion.
- Acquisition values are allow-listed and stored once.

### End to end

- Start from a fresh sandbox database.
- Log in with the displayed demo account.
- Play a guess, browse archive, inspect account statistics, open friends and leaderboard, exercise sharing and log out.
- Create a new temporary user and verify local confirmation/reset output.
- Inspect all public pages and overlays on an iPhone-sized WebKit viewport and desktop.
- Use `/compare.html` to inspect the captured production baseline beside the interactive sandbox.

The pre-existing matcher regression in which generic “fasciitis” matches “Plantar Fasciitis” remains outside this project unless it blocks another verified flow.

## Delivery

All work remains on `codex/apple-liquid-glass-sandbox` under the existing `CODEX` worktree. Commits are small enough to review by concern. The local preview remains on a throwaway database. No push or deployment occurs without explicit approval.
