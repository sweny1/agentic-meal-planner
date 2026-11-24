// the page talks to the FastAPI endpoints in api.py (same server, so no full URL needed)

const userInput = document.getElementById('user-input');
const switchUserBtn = document.getElementById('switch-user-btn');
const newConversationBtn = document.getElementById('new-conversation-btn');
const conversationSelect = document.getElementById('conversation-select');
const messagesBox = document.getElementById('messages');
const chatForm = document.getElementById('chat-form');
const messageInput = document.getElementById('message-input');
const sendBtn = document.getElementById('send-btn');
const preferencesList = document.getElementById('preferences-list');
const groceryList = document.getElementById('grocery-list');
const refreshBtn = document.getElementById('refresh-btn');

let userId = userInput.value.trim().toLowerCase();
// a conversation is a LangGraph thread, so its id is sent as thread_id: riya-conversation-1, riya-conversation-2, ...
let conversationId = '';
let conversations = []; // previous conversations of this user, from the server, newest first

function newConversationId() {
  // one more than the highest number used so far
  const numbers = conversations.map((c) => Number(c.thread_id.split('-conversation-')[1]) || 0);
  return `${userId}-conversation-${Math.max(0, ...numbers) + 1}`;
}


// ---------- show messages ----------

function addMessage(type, text) {
  const div = document.createElement('div');
  div.className = `message ${type}`;
  div.textContent = text;
  messagesBox.appendChild(div);
  messagesBox.scrollTop = messagesBox.scrollHeight;
  return div;
}


// ---------- the list of previous conversations ----------

async function loadConversations() {
  const response = await fetch(`/users/${userId}/conversations`);
  const data = await response.json();
  conversations = data.conversations;
  fillConversationSelect();
}

function fillConversationSelect() {
  conversationSelect.innerHTML = '';

  // a new conversation is not in the list until its first message is sent
  if (!conversations.some((c) => c.thread_id === conversationId)) {
    conversationSelect.appendChild(new Option('New conversation', conversationId));
  }
  for (const conversation of conversations) {
    conversationSelect.appendChild(new Option(conversation.title, conversation.thread_id));
  }
  conversationSelect.value = conversationId;
}


// ---------- short-term memory: load the saved chat of this conversation ----------

async function loadConversation() {
  fillConversationSelect();
  messagesBox.innerHTML = '';
  setBusy(false);

  const response = await fetch(`/conversations/${conversationId}/messages`);
  const data = await response.json();

  if (data.messages.length === 0) {
    addMessage('ai thinking', 'New conversation. Ask the Head Chef anything!');
  }
  data.messages.forEach((message) => addMessage(message.type, message.content));

  await checkPending(); // shows the approval card (and blocks Send) if the thread is paused
}

// ---------- long-term memory: preferences and grocery list of this user ----------

function fillList(listElement, items, emptyText) {
  listElement.innerHTML = '';
  if (items.length === 0) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = emptyText;
    listElement.appendChild(li);
  }
  for (const item of items) {
    const li = document.createElement('li');
    li.textContent = item;
    listElement.appendChild(li);
  }
}

async function loadMemory() {
  const preferencesResponse = await fetch(`/users/${userId}/preferences`);
  const preferencesData = await preferencesResponse.json();
  fillList(preferencesList, preferencesData.preferences, 'nothing saved yet');

  const groceryResponse = await fetch(`/users/${userId}/grocery`);
  const groceryData = await groceryResponse.json();
  fillList(groceryList, groceryData.grocery_list, 'empty');
}

// ---------- busy state: true while streaming OR while an approval is pending ----------

function setBusy(value) {
  sendBtn.disabled = value;
}

function scrollDown() {
  messagesBox.scrollTop = messagesBox.scrollHeight;
}

// ---------- one function streams both a new message and a resume ----------
// payload is either { message } or { decisions }

async function streamChat(payload) {
  setBusy(true);
  let bubble = null;   // the AI bubble that grows token by token
  let paused = false;  // true if the agent stopped to ask for approval

  try {
    const response = await fetch('/chat/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: userId, thread_id: conversationId, ...payload }),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      throw new Error(body?.detail || response.statusText);
    }

    // NDJSON: one JSON event per line
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      const lines = buffer.split('\n');
      buffer = lines.pop(); // keep the unfinished line for the next chunk

      for (const line of lines.filter((l) => l.trim())) {
        const event = JSON.parse(line);
        if (event.type === 'token') {
          bubble ??= addMessage('ai', '');
          bubble.textContent += event.text;
          scrollDown();
        } else if (event.type === 'interrupt') {
          paused = true;
          showApprovalUI(event.actions, event.review_configs);
        } else if (event.type === 'error') {
          throw new Error(event.message);
        }
      }
    }
  } catch (error) {
    addMessage('ai', 'Error: ' + error.message);
    paused = await checkPending(); // if the failure left an approval pending, show the card again
  } finally {
    setBusy(paused);
    await loadConversations(); // a first message adds the conversation to the list
    await loadMemory();        // the agent may have saved a preference / grocery item
  }
}

// ---------- human approval card ----------

function escapeHtml(text) {
  return text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function showApprovalUI(actions, reviewConfigs = []) {
  const box = document.createElement('div');
  box.className = 'approval-container';
  box.innerHTML =
    '<h3>Human approval required</h3>' +
    actions.map((action, i) => {
      const allowed = reviewConfigs[i]?.allowed_decisions || ['approve', 'edit', 'reject'];
      return `
        <div class="approval-card">
          <h4>${escapeHtml(action.name)}</h4>
          <textarea rows="5">${escapeHtml(JSON.stringify(action.args, null, 2))}</textarea>
          <select>${allowed.map((d) => `<option value="${d}">${d[0].toUpperCase() + d.slice(1)}</option>`).join('')}</select>
        </div>`;
    }).join('') +
    '<p class="approval-error"></p><button type="button">Submit decisions</button>';

  const cards = [...box.querySelectorAll('.approval-card')];

  box.querySelector('button').onclick = () => {
    try {
      const decisions = cards.map((card, i) => {
        const type = card.querySelector('select').value;
        if (type === 'approve') return { type };
        if (type === 'reject') return { type, message: 'User rejected this action. Do not retry it.' };
        return {
          type, // 'edit'
          edited_action: { name: actions[i].name, args: JSON.parse(card.querySelector('textarea').value) },
        };
      });
      box.remove();
      streamChat({ decisions });
    } catch (error) {
      box.querySelector('.approval-error').textContent = 'Arguments must be valid JSON: ' + error.message;
    }
  };

  messagesBox.appendChild(box);
  scrollDown();
  setBusy(true); // typing a new message is blocked until this card is answered
}

// re-open the card after a page reload / conversation switch / failed resume
async function checkPending() {
  const response = await fetch(`/chat/pending/${conversationId}`);
  const data = await response.json();
  if (data.status === 'interrupt') showApprovalUI(data.actions, data.review_configs || []);
  return data.status === 'interrupt';
}

// ---------- buttons ----------

chatForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const text = messageInput.value.trim();
  if (!text || sendBtn.disabled) return; // empty, or streaming / waiting for approval
  messageInput.value = '';
  addMessage('human', text);
  await streamChat({ message: text });
});

newConversationBtn.addEventListener('click', async () => {
  // a new conversation forgets the chat, but long-term memory stays
  conversationId = newConversationId();
  await loadConversation();
});

conversationSelect.addEventListener('change', async () => {
  // go back to a previous conversation: its saved chat is loaded from Postgres
  conversationId = conversationSelect.value;
  await loadConversation();
});

async function startUser() {
  // open the newest conversation of this user, or a new one if there is none yet
  await loadConversations();
  conversationId = conversations.length > 0 ? conversations[0].thread_id : newConversationId();
  await loadConversation();
  await loadMemory();
}

switchUserBtn.addEventListener('click', async () => {
  // a different user has their own conversations, preferences and grocery list (isolation)
  userId = userInput.value.trim().toLowerCase() || 'guest';
  await startUser();
});

refreshBtn.addEventListener('click', loadMemory);


// ---------- start ----------

startUser();
