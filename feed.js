'use strict';

(() => {
  const STORAGE_PREFIX = 'account-demo.feed.v1.';
  const MAX_COMMENTS = 50;
  const MAX_POSTS = 20;
  const BASE_LIKES = 128;
  const BASE_COMMENTS = 2;
  const $ = selector => document.querySelector(selector);
  const $$ = selector => [...document.querySelectorAll(selector)];
  const sessions = new Map();
  const unsavedSessions = new Set();
  let user = null;
  let feedState = null;
  let boundView = null;
  let activeTab = 'home';
  let statusTimer;
  let draftImage = '';
  let imageLoading = false;
  let imageRequest = 0;
  const commentDrafts = new Map();

  function emptyState() { return { version: 1, liked: false, saved: false, comments: [], posts: [] }; }
  function storageKey(email) { return STORAGE_PREFIX + encodeURIComponent(email); }
  function reducedMotion() { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; }
  function initials(name) {
    return name.trim().split(/\s+/).slice(0, 2).map(part => [...part][0] || '').join('').toUpperCase() || 'U';
  }
  function status(message) {
    const node = $('#feed-status');
    if (!node) return;
    node.textContent = message;
    node.hidden = !message;
    clearTimeout(statusTimer);
    if (message) statusTimer = setTimeout(() => { node.textContent = ''; node.hidden = true; }, 4500);
  }

  function normalizeState(value) {
    if (!value || value.version !== 1 || !Array.isArray(value.comments)) return emptyState();
    return {
      version: 1,
      liked: value.liked === true,
      saved: value.saved === true,
      comments: cleanComments(value.comments),
      posts: cleanPosts(value.posts)
    };
  }

  function cleanComments(comments) {
    return (Array.isArray(comments) ? comments : []).slice(-MAX_COMMENTS).filter(comment => comment && typeof comment.name === 'string' &&
        comment.name.trim().length > 0 && comment.name.length <= 60 && typeof comment.text === 'string' &&
        comment.text.trim().length > 0 && comment.text.length <= 300)
        .map(comment => ({ name: comment.name.trim(), text: comment.text.trim() }));
  }

  function cleanPosts(posts) {
    const ids = new Set();
    return (Array.isArray(posts) ? posts : []).slice(-MAX_POSTS).filter(post => {
      if (!post || typeof post.id !== 'string' || !/^own-[a-z0-9-]{8,48}$/.test(post.id) || ids.has(post.id) || typeof post.caption !== 'string' || post.caption.length > 1000 || typeof post.author !== 'string' || !post.author.trim() || post.author.length > 60 || !Number.isFinite(Date.parse(post.createdAt))) return false;
      ids.add(post.id);
      return true;
    }).map(post => {
      const image = typeof post.image === 'string' && post.image.length <= 240000 && /^data:image\/jpeg;base64,[A-Za-z0-9+/]+=*$/.test(post.image) ? post.image : '';
      return { id: post.id, caption: post.caption.trim(), image, author: post.author.trim(), createdAt: post.createdAt, liked: post.liked === true, saved: post.saved === true, comments: cleanComments(post.comments) };
    }).filter(post => post.caption || post.image);
  }

  function makeNode(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function accountAvatar(className, name, email) {
    const avatar = makeNode(email === 'demo@example.com' ? 'img' : 'span', className);
    if (avatar instanceof HTMLImageElement) {
      avatar.src = 'assets/nash-profile.jpg';
      avatar.alt = '';
    } else {
      avatar.textContent = initials(name);
      avatar.setAttribute('aria-hidden', 'true');
    }
    return avatar;
  }

  function currentPost(id) {
    return id === 'coast-01' ? feedState : feedState?.posts.find(post => post.id === id);
  }

  function validSession() {
    try {
      const session = JSON.parse(sessionStorage.getItem('account-demo.session.v1'));
      if (!user || !session || session.email !== user.email || session.revision !== user.revision) throw new Error('Session ended');
      const accounts = JSON.parse(localStorage.getItem('account-demo.accounts.v1'));
      if (!Array.isArray(accounts) || !accounts.some(account => account.email === user.email && account.revision === session.revision)) throw new Error('Session ended');
      return true;
    } catch {
      deactivate();
      location.hash = '/login';
      return false;
    }
  }

  function loadState(email) {
    if (unsavedSessions.has(email)) {
      status('Your feed changes are saved for this visit only because browser storage is unavailable.');
      return sessions.get(email) || emptyState();
    }
    try {
      const raw = localStorage.getItem(storageKey(email));
      const next = raw ? normalizeState(JSON.parse(raw)) : emptyState();
      sessions.set(email, next);
      return next;
    } catch {
      status('Your feed changes can be used for this visit. Browser storage is unavailable.');
      return sessions.get(email) || emptyState();
    }
  }

  function saveState(message) {
    sessions.set(user.email, feedState);
    try {
      localStorage.setItem(storageKey(user.email), JSON.stringify(feedState));
      unsavedSessions.delete(user.email);
      status(message);
    } catch {
      unsavedSessions.add(user.email);
      status(`${message} This change is saved for this visit only because browser storage is unavailable.`);
    }
  }

  function updatePost() {
    if (!feedState) return;
    const like = $('#post-like');
    const save = $('#post-save');
    if (like) {
      like.setAttribute('aria-pressed', String(feedState.liked));
      like.setAttribute('aria-label', feedState.liked ? 'Unlike this post' : 'Like this post');
      like.classList.toggle('liked', feedState.liked);
    }
    if (save) {
      save.setAttribute('aria-pressed', String(feedState.saved));
      save.setAttribute('aria-label', feedState.saved ? 'Remove saved post' : 'Save this post');
      save.classList.toggle('saved', feedState.saved);
    }
    const count = $('#like-count');
    if (count) count.textContent = String(BASE_LIKES + Number(feedState.liked));
    const commentCount = $('#comment-count');
    if (commentCount) commentCount.textContent = String(BASE_COMMENTS + feedState.comments.length);
    const list = $('#comment-list');
    if (list) {
      list.querySelectorAll('[data-demo-comment]').forEach(node => node.remove());
      feedState.comments.forEach(comment => {
        const row = document.createElement('div');
        row.className = 'feed-comment';
        row.dataset.demoComment = 'true';
        const author = document.createElement('strong');
        author.className = 'comment-author';
        author.textContent = comment.name;
        const text = document.createElement('span');
        text.className = 'comment-text';
        text.textContent = comment.text;
        row.append(author, document.createTextNode(' '), text);
        list.append(row);
      });
    }
    const placeholder = $('#saved-post-placeholder');
    const preview = $('#saved-post-preview');
    if (placeholder) placeholder.hidden = feedState.saved || feedState.posts.some(post => post.saved);
    if (preview) preview.hidden = !feedState.saved;
    renderCreatedPosts();
    renderPostPreviews();
  }

  function actionButton(action, label, post, path) {
    const button = makeNode('button', 'icon-button');
    button.type = 'button';
    button.dataset.postAction = action;
    button.dataset.postTarget = post.id;
    button.setAttribute('aria-label', label);
    if (['like', 'save'].includes(action)) {
      const selected = action === 'like' ? post.liked : post.saved;
      button.classList.toggle(action === 'like' ? 'liked' : 'saved', selected);
      button.setAttribute('aria-pressed', String(selected));
    }
    // SVG paths are fixed icon shapes; captions, author names and comments use textContent.
    button.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${path}"/></svg>`;
    return button;
  }

  function renderCreatedPosts() {
    const container = $('#created-posts');
    container.replaceChildren();
    [...feedState.posts].reverse().forEach(post => {
      const card = makeNode('article', 'post-card created-post');
      card.id = `post-${post.id}`;
      card.dataset.postId = post.id;
      card.setAttribute('aria-label', `Post by ${post.author}`);
      const header = makeNode('header', 'post-header');
      const avatar = accountAvatar('initial-avatar post-initial profile-photo', post.author, user.email);
      const author = makeNode('div');
      author.append(makeNode('h2', '', post.author), makeNode('p', '', new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(post.createdAt))));
      header.append(avatar, author, makeNode('span', 'post-category', 'YOUR POST'));
      card.append(header);
      if (post.image) {
        const image = makeNode('img', 'post-image');
        image.src = post.image;
        image.alt = `Photo shared by ${post.author}`;
        image.loading = 'lazy';
        const wrap = makeNode('div', 'post-image-wrap');
        wrap.append(image);
        card.append(wrap);
      }
      const body = makeNode('div', 'post-body');
      const actions = makeNode('div', 'post-actions');
      const left = makeNode('div');
      left.append(actionButton('like', post.liked ? 'Unlike this post' : 'Like this post', post, 'M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z'), actionButton('comment', 'Write a comment', post, 'M21 11.5a9 9 0 0 1-9.5 9L3 22l1.6-7A9 9 0 1 1 21 11.5Z'), actionButton('share', 'Copy post link', post, 'm22 2-7 20-4-9L2 9 22 2ZM11 13 22 2'));
      actions.append(left, actionButton('save', post.saved ? 'Remove saved post' : 'Save this post', post, 'M6 3h12v18l-6-4-6 4Z'));
      const likes = makeNode('p', 'post-likes');
      likes.append(makeNode('strong', '', Number(post.liked)), document.createTextNode(' likes'));
      const caption = makeNode('p', 'post-caption');
      caption.append(makeNode('strong', '', post.author), document.createTextNode(` ${post.caption}`));
      const comments = makeNode('div', 'comment-list');
      post.comments.forEach(comment => {
        const row = makeNode('p', 'feed-comment');
        row.append(makeNode('strong', 'comment-author', comment.name), document.createTextNode(' '), makeNode('span', 'comment-text', comment.text));
        comments.append(row);
      });
      const form = makeNode('form', 'comment-form');
      form.dataset.commentPost = post.id;
      const label = makeNode('label', 'visually-hidden', `Add a comment to ${post.author}'s post`);
      label.htmlFor = `comment-${post.id}`;
      const input = makeNode('input');
      input.id = `comment-${post.id}`;
      input.name = 'comment';
      input.placeholder = 'Add a comment…';
      input.maxLength = 300;
      input.required = true;
      input.autocomplete = 'off';
      input.value = commentDrafts.get(post.id) || '';
      const submit = makeNode('button', '', 'Post ↗');
      submit.type = 'submit';
      form.append(label, input, submit);
      body.append(actions, likes);
      if (post.caption) body.append(caption);
      body.append(makeNode('p', 'comment-label', `${post.comments.length} comments`), comments, form);
      card.append(body);
      container.append(card);
    });
  }

  function postPreview(post) {
    const button = makeNode('button', 'saved-preview');
    button.type = 'button';
    button.dataset.openPost = post.id;
    if (post.image) {
      const image = makeNode('img');
      image.src = post.image;
      image.alt = 'Your published photo';
      button.append(image);
    } else button.append(makeNode('span', 'text-post-preview', 'Aa'));
    const copy = makeNode('span');
    copy.append(makeNode('strong', '', post.author), makeNode('small', '', post.caption || 'A photo from your day'));
    button.append(copy, makeNode('span', '', '↗'));
    return button;
  }

  function renderPostPreviews() {
    const saved = $('#saved-created-posts');
    const profile = $('#profile-posts');
    saved.replaceChildren();
    profile.replaceChildren();
    [...feedState.posts].reverse().forEach(post => {
      if (post.saved) saved.append(postPreview(post));
      profile.append(postPreview(post));
    });
    $('#profile-posts-empty').hidden = feedState.posts.length !== 0;
    $('#profile-post-count').textContent = `${feedState.posts.length} ${feedState.posts.length === 1 ? 'post' : 'posts'}`;
  }

  function showTab(tab, focus = false, syncUrl = false) {
    if (!['home', 'saved', 'profile'].includes(tab)) return;
    activeTab = tab;
    if (syncUrl) history.replaceState(null, '', tab === 'home' ? '#/feed' : `#/feed?tab=${tab}`);
    ['home', 'saved', 'profile'].forEach(name => {
      const pane = $(`#feed-${name}`);
      if (pane) pane.hidden = name !== tab;
    });
    $$('[data-feed-tab]').forEach(button => {
      const selected = button.dataset.feedTab === tab;
      button.classList.toggle('active', selected);
      if (button.closest('nav')) {
        if (selected) button.setAttribute('aria-current', 'page');
        else button.removeAttribute('aria-current');
      }
      if (button.getAttribute('role') === 'tab') button.setAttribute('aria-selected', String(selected));
      else button.setAttribute('aria-pressed', String(selected));
    });
    if (tab === 'home') requestAnimationFrame(updateStoryScroll);
    const heading = $(`#feed-${tab} h1`);
    if (heading) document.title = `${heading.textContent} — InstaGreed`;
    if (focus) {
      if (heading) { heading.tabIndex = -1; heading.focus({ preventScroll: true }); }
    }
  }

  function updateStoryScroll() {
    const track = $('#stories-track');
    if (!track) return;
    const max = Math.max(0, track.scrollWidth - track.clientWidth);
    const previous = $('#stories-prev');
    const next = $('#stories-next');
    if (previous) previous.disabled = track.scrollLeft <= 2;
    if (next) next.disabled = track.scrollLeft >= max - 2;
  }

  function scrollStories(direction, edge) {
    const track = $('#stories-track');
    if (!track) return;
    const left = edge === 'start' ? 0 : edge === 'end' ? track.scrollWidth :
      track.scrollLeft + direction * Math.max(180, track.clientWidth * 0.7);
    track.scrollTo({ left, behavior: reducedMotion() ? 'instant' : 'smooth' });
    requestAnimationFrame(updateStoryScroll);
  }

  function closeStory() {
    const dialog = $('#feed-story-dialog');
    if (dialog?.open) dialog.close();
  }

  function openStory(button) {
    const dialog = $('#feed-story-dialog');
    if (!dialog) return;
    const image = button.querySelector('img');
    const name = button.dataset.storyName || image?.alt || button.textContent.trim() || 'Profile';
    const detail = button.dataset.storyDetail || `${name} shared a moment from their day. Explore the post below.`;
    const title = $('#story-name');
    const copy = $('#story-detail');
    const avatar = $('#story-avatar');
    if (title) title.textContent = name;
    if (copy) copy.textContent = detail;
    if (avatar instanceof HTMLImageElement) {
      avatar.hidden = !image;
      if (image) { avatar.src = image.src; avatar.alt = `${name}'s profile`; }
    } else if (avatar) avatar.textContent = initials(name);
    if (!dialog.open) dialog.showModal();
  }

  async function sharePost(id = 'coast-01') {
    if (!validSession()) return;
    const url = new URL(location.href);
    url.search = '';
    url.hash = `/feed?post=${encodeURIComponent(id)}`;
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(url.href);
      status('Post link copied. This demo link opens the feed after login.');
    } catch {
      $('#share-post-url').value = url.href;
      $('#share-copy-status').textContent = 'Select the link and copy it, or use Copy link.';
      const dialog = $('#share-post-dialog');
      if (!dialog.open) dialog.showModal();
      $('#share-post-url').focus();
      $('#share-post-url').select();
    }
  }

  function openPost(id = 'coast-01') {
    showTab('home', false, true);
    const post = id === 'coast-01' ? $('#sample-post') : document.getElementById(`post-${id}`);
    if (post) {
      history.replaceState(null, '', `#/feed?post=${encodeURIComponent(id)}`);
      post.scrollIntoView({ behavior: reducedMotion() ? 'instant' : 'smooth', block: 'start' });
      post.tabIndex = -1;
      post.focus({ preventScroll: true });
    } else status('This post is not saved in this browser account. Your other posts are still here.');
  }

  function togglePost(id, property) {
    if (!validSession()) return;
    const post = currentPost(id);
    if (!post) return;
    post[property] = !post[property];
    updatePost();
    saveState(property === 'liked' ? (post.liked ? 'You liked this post.' : 'Like removed.') : (post.saved ? 'Post saved. Open Saved to see it.' : 'Post removed from Saved.'));
    if (id !== 'coast-01') document.querySelector(`[data-post-target="${id}"][data-post-action="${property === 'liked' ? 'like' : 'save'}"]`)?.focus({ preventScroll: true });
  }

  function addComment(id, input) {
    if (!validSession()) return;
    const post = currentPost(id);
    if (!post) return;
    const text = input?.value.trim() || '';
    if (!text || text.length > 300) { status('Type a comment between 1 and 300 characters.'); input?.focus(); return; }
    if (post.comments.length >= MAX_COMMENTS) { status('This demo keeps up to 50 comments per post.'); return; }
    post.comments.push({ name: user.name, text });
    commentDrafts.delete(id);
    input.value = '';
    updatePost();
    saveState('Your comment was posted.');
    const nextInput = id === 'coast-01' ? $('#comment-input') : document.getElementById(`comment-${id}`);
    nextInput?.focus({ preventScroll: true });
  }

  function composerError(message) {
    const error = $('#create-post-error');
    error.textContent = message;
    error.hidden = false;
  }

  function closeComposer() {
    imageRequest += 1;
    imageLoading = false;
    draftImage = '';
    $('#create-post-dialog').close();
    $('#create-post-form').reset();
    $('#create-post-error').hidden = true;
    $('#create-image-preview').hidden = true;
    $('#create-image').removeAttribute('src');
    $('#caption-count').textContent = '0';
    $('#publish-post').disabled = false;
  }

  function openComposer() {
    if (!validSession()) return;
    if (feedState.posts.length >= MAX_POSTS) { status('This browser demo keeps up to 20 posts per account.'); return; }
    $('#create-post-error').hidden = true;
    const dialog = $('#create-post-dialog');
    if (!dialog.open) dialog.showModal();
    $('#create-post-caption').focus();
  }

  async function resizePhoto(file) {
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error('Choose a PNG, JPG or WebP photo.');
    if (file.size > 5 * 1024 * 1024) throw new Error('Choose a photo smaller than 5 MB.');
    const objectUrl = URL.createObjectURL(file);
    try {
      const image = new Image();
      await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = () => reject(new Error('This photo could not be read. Try a different image.')); image.src = objectUrl; });
      if (!image.naturalWidth || !image.naturalHeight || image.naturalWidth * image.naturalHeight > 80000000) throw new Error('Choose a smaller image.');
      const scale = Math.min(1, 1000 / Math.max(image.naturalWidth, image.naturalHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      const context = canvas.getContext('2d');
      if (!context) throw new Error('This browser cannot prepare the photo.');
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      let data = canvas.toDataURL('image/jpeg', .82);
      if (data.length > 240000) data = canvas.toDataURL('image/jpeg', .55);
      if (data.length > 240000) throw new Error('This photo is too detailed to store in the local demo. Choose a smaller photo.');
      return data;
    } finally { URL.revokeObjectURL(objectUrl); }
  }

  async function selectPhoto(event) {
    const request = ++imageRequest;
    const file = event.target.files?.[0];
    draftImage = '';
    imageLoading = false;
    $('#publish-post').disabled = false;
    $('#create-image-preview').hidden = true;
    $('#create-post-error').hidden = true;
    if (!file) return;
    imageLoading = true;
    $('#publish-post').disabled = true;
    try {
      const data = await resizePhoto(file);
      if (request !== imageRequest || !$('#create-post-dialog').open) return;
      draftImage = data;
      $('#create-image').src = data;
      $('#create-image-preview').hidden = false;
    } catch (error) {
      if (request === imageRequest) { event.target.value = ''; composerError(error.message); }
    } finally {
      if (request === imageRequest) { imageLoading = false; $('#publish-post').disabled = false; }
    }
  }

  function publishPost(event) {
    event.preventDefault();
    if (!validSession() || imageLoading) return;
    const caption = $('#create-post-caption').value.trim();
    if (!caption && !draftImage) { composerError('Write a caption or choose a photo before publishing.'); $('#create-post-caption').focus(); return; }
    if (caption.length > 1000 || feedState.posts.length >= MAX_POSTS) { composerError('This demo allows 1000 caption characters and up to 20 posts per account.'); return; }
    const id = `own-${crypto.randomUUID()}`;
    feedState.posts.push({ id, author: user.name, caption, image: draftImage, createdAt: new Date().toISOString(), liked: false, saved: false, comments: [] });
    updatePost();
    saveState('Your post was published to this browser demo.');
    closeComposer();
    openPost(id);
  }

  function deactivate() {
    closeStory();
    closeComposer();
    $('#share-post-dialog').close();
    commentDrafts.clear();
    user = null;
    feedState = null;
    activeTab = 'home';
    status('');
  }

  function bindView() {
    const view = $('#view-feed');
    if (!view || boundView === view) return;
    boundView = view;
    view.addEventListener('click', event => {
      if (!(event.target instanceof Element)) return;
      const story = event.target.closest('[data-story]');
      if (story && view.contains(story)) { openStory(story); return; }
      if (event.target.closest('[data-create-post]')) { openComposer(); return; }
      const nav = event.target.closest('[data-feed-tab]');
      if (nav && view.contains(nav)) { showTab(nav.dataset.feedTab, true, true); status(''); return; }
      const preview = event.target.closest('[data-open-post]');
      if (preview) { openPost(preview.dataset.openPost || 'coast-01'); return; }
      const action = event.target.closest('[data-post-action]');
      if (action) {
        const id = action.dataset.postTarget;
        if (action.dataset.postAction === 'like') togglePost(id, 'liked');
        if (action.dataset.postAction === 'save') togglePost(id, 'saved');
        if (action.dataset.postAction === 'share') sharePost(id);
        if (action.dataset.postAction === 'comment') {
          const input = document.getElementById(`comment-${id}`);
          input?.scrollIntoView({ behavior: reducedMotion() ? 'instant' : 'smooth', block: 'center' });
          input?.focus({ preventScroll: true });
        }
      }
    });
    view.addEventListener('submit', event => {
      const form = event.target.closest('[data-comment-post]');
      if (!form) return;
      event.preventDefault();
      addComment(form.dataset.commentPost, form.querySelector('input'));
    });
    view.addEventListener('input', event => {
      const form = event.target.closest('[data-comment-post]');
      if (form && event.target instanceof HTMLInputElement) commentDrafts.set(form.dataset.commentPost, event.target.value);
    });
    $('#stories-prev')?.addEventListener('click', () => scrollStories(-1));
    $('#stories-next')?.addEventListener('click', () => scrollStories(1));
    const track = $('#stories-track');
    track?.addEventListener('scroll', updateStoryScroll, { passive: true });
    track?.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      scrollStories(event.key === 'ArrowLeft' ? -1 : 1, event.key === 'Home' ? 'start' : event.key === 'End' ? 'end' : undefined);
    });
    window.addEventListener('resize', updateStoryScroll);
    if (track && 'ResizeObserver' in window) new ResizeObserver(updateStoryScroll).observe(track);
    $('#story-close')?.addEventListener('click', closeStory);
    $('#story-view-post')?.addEventListener('click', () => {
      closeStory();
      openPost();
    });
    $('#feed-story-dialog')?.addEventListener('click', event => {
      if (event.target !== event.currentTarget) return;
      const bounds = event.currentTarget.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) closeStory();
    });
    $('#post-like')?.addEventListener('click', () => {
      togglePost('coast-01', 'liked');
    });
    $('#post-save')?.addEventListener('click', () => {
      togglePost('coast-01', 'saved');
    });
    $('#post-comment')?.addEventListener('click', () => {
      const input = $('#comment-input');
      input?.scrollIntoView({ behavior: reducedMotion() ? 'instant' : 'smooth', block: 'center' });
      input?.focus({ preventScroll: true });
    });
    $('#post-share')?.addEventListener('click', () => sharePost());
    $('#comment-form')?.addEventListener('submit', event => {
      event.preventDefault();
      addComment('coast-01', $('#comment-input'));
    });
    $('#create-post-close').addEventListener('click', closeComposer);
    $('#cancel-create-post').addEventListener('click', closeComposer);
    $('#create-post-form').addEventListener('submit', publishPost);
    $('#create-post-image').addEventListener('change', selectPhoto);
    $('#create-post-caption').addEventListener('input', event => { $('#caption-count').textContent = String(event.target.value.length); $('#create-post-error').hidden = true; });
    $('#remove-create-image').addEventListener('click', () => {
      imageRequest += 1;
      imageLoading = false;
      draftImage = '';
      $('#create-post-image').value = '';
      $('#create-image').removeAttribute('src');
      $('#create-image-preview').hidden = true;
      $('#publish-post').disabled = false;
    });
    $('#create-post-dialog').addEventListener('cancel', event => { event.preventDefault(); closeComposer(); });
    $('#share-post-close').addEventListener('click', () => $('#share-post-dialog').close());
    $('#share-copy-link').addEventListener('click', async () => {
      const input = $('#share-post-url');
      input.focus();
      input.select();
      try { await navigator.clipboard.writeText(input.value); $('#share-copy-status').textContent = 'Link copied.'; }
      catch { $('#share-copy-status').textContent = 'Press Ctrl+C or use your browser’s Copy command to copy the selected link.'; }
    });
    window.addEventListener('storage', event => {
      if (!user || ![storageKey(user.email), null].includes(event.key)) return;
      feedState = loadState(user.email);
      updatePost();
    });
  }

  function render(currentUser) {
    if (!currentUser || typeof currentUser.email !== 'string' || typeof currentUser.name !== 'string') return;
    const email = currentUser.email.trim().toLowerCase();
    const changedAccount = user?.email !== email;
    user = { name: currentUser.name.trim().slice(0, 60) || 'Demo User', email, revision: currentUser.revision };
    status('');
    feedState = loadState(email);
    bindView();
    $('#profile-name').textContent = user.name;
    const emailNode = $('#profile-email');
    if (emailNode) emailNode.textContent = user.email;
    ['#feed-user-avatar', '#profile-avatar'].forEach(selector => {
      const node = $(selector);
      if (!node) return;
      const avatar = accountAvatar(node.className, user.name, user.email);
      avatar.id = node.id;
      if (avatar instanceof HTMLImageElement) avatar.alt = 'Your profile picture';
      node.replaceWith(avatar);
    });
    updatePost();
    if (changedAccount) { activeTab = 'home'; commentDrafts.clear(); const input = $('#comment-input'); if (input) input.value = ''; closeStory(); closeComposer(); }
    const params = new URLSearchParams(location.hash.split('?')[1] || '');
    const requestedTab = params.get('tab');
    const postId = params.get('post');
    showTab(postId ? 'home' : ['home', 'saved', 'profile'].includes(requestedTab) ? requestedTab : activeTab);
    if (postId) requestAnimationFrame(() => openPost(postId));
  }

  window.AccountFeed = Object.freeze({ render, deactivate });
})();
