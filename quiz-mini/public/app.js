const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

const BACKEND_URL = (typeof window !== 'undefined' && window.API_BASE_URL)
  ? window.API_BASE_URL.replace(/\/$/, '')
  : '';

const api = async (url, options = {}) => {
  const response = await fetch(`${BACKEND_URL}/api${url}`, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || 'Đã xảy ra lỗi.');
  return data;
};

// State variables
let participantId = localStorage.getItem('quiz_participant_id') || null;
let participantName = localStorage.getItem('quiz_participant_name') || '';
let participantMssv = localStorage.getItem('quiz_participant_mssv') || '';
let currentQuizId = null;
let pollHandle = null;
let editorCount = 0;
let selectedAdminQuiz = Number(localStorage.getItem('quiz_selected_admin_quiz')) || null;
let quizInProgress = false;

// Step-by-step quiz runner state
let currentQuestions = [];
let currentQuestionIndex = 0;
let collectedAnswers = [];
let questionStartTime = 0;
let questionTimerInterval = null;
let questionTimeLimitMs = 20000;
let currentQuestionMaxPoints = 10;
let isAnswerLocked = false;

// Admin state
let adminCurrentSubView = localStorage.getItem('quiz_admin_subview') || 'admin-page-quizzes';
let cachedQuizzes = [];
let ws = null;
let wsReconnectTimer = null;
const openRankMssv = {};
let editingQuizId = null;

function showMessage(selector, text) {
  const el = $(selector);
  if (el) el.textContent = text || '';
}

// Navigation between views (Tham gia / Quản trị)
function setView(id) {
  $$('.view').forEach(el => el.classList.toggle('hidden', el.id !== id));
  $$('.nav-btn').forEach(btn => btn.classList.toggle('active', btn.dataset.view === id));
  localStorage.setItem('quiz_active_view', id);
  if (id === 'admin-view') {
    checkAdmin();
  }
}
$$('.nav-btn').forEach(btn => btn.addEventListener('click', () => setView(btn.dataset.view)));

// JOIN QUIZ (THAM GIA PHÒNG CHỜ)
$('#join-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  showMessage('#join-message', '');
  const form = new FormData(e.currentTarget);
  const fullName = form.get('full_name').trim();
  const candidateNumber = form.get('candidate_number').trim();

  try {
    const result = await api('/public/join', {
      method: 'POST',
      body: JSON.stringify({ full_name: fullName, candidate_number: candidateNumber })
    });

    participantId = result.participant_id;
    participantName = fullName;
    participantMssv = candidateNumber;
    currentQuizId = result.quiz_id;

    localStorage.setItem('quiz_participant_id', participantId);
    localStorage.setItem('quiz_participant_name', participantName);
    localStorage.setItem('quiz_participant_mssv', participantMssv);

    showWaitingPanel();
    startPolling();
  } catch (err) {
    showMessage('#join-message', err.message);
  }
});

function showWaitingPanel() {
  $('#join-panel').classList.add('hidden');
  $('#quiz-panel').classList.add('hidden');
  $('#result-panel').classList.add('hidden');
  $('#waiting-panel').classList.remove('hidden');

  $('#waiting-title').textContent = 'Bạn đang ở phòng chờ';
  const infoEl = $('#waiting-user-info');
  if (infoEl) {
    infoEl.textContent = `Thí sinh: ${participantName} | MSSV: ${participantMssv}`;
  }
}

// Reset participant session (Đổi MSSV / Thoát)
function resetParticipantSession() {
  clearInterval(pollHandle);
  clearInterval(questionTimerInterval);
  participantId = null;
  participantName = '';
  participantMssv = '';
  quizInProgress = false;
  currentQuestions = [];
  currentQuestionIndex = 0;
  collectedAnswers = [];

  localStorage.removeItem('quiz_participant_id');
  localStorage.removeItem('quiz_participant_name');
  localStorage.removeItem('quiz_participant_mssv');

  $('#waiting-panel').classList.add('hidden');
  $('#quiz-panel').classList.add('hidden');
  $('#result-panel').classList.add('hidden');
  $('#join-panel').classList.remove('hidden');
  showMessage('#join-message', '');
}

$$('.reset-user-btn').forEach(btn => btn.addEventListener('click', resetParticipantSession));

// POLLING PARTICIPANT STATE
// POLLING PARTICIPANT STATE (TỐI ƯU HÓA JITTER TRÁNH NGHẼN AIVEN & RENDER KHI 100 NGƯỜI CHỜ)
function startPolling() {
  clearTimeout(pollHandle);
  checkParticipantState();
  scheduleNextPoll();
}

function scheduleNextPoll() {
  clearTimeout(pollHandle);
  if (!participantId || quizInProgress) return;
  // Giãn cách ngẫu nhiên từ 3000ms đến 4500ms để phân tán tải đều trên Render/Aiven
  const delay = 3000 + Math.floor(Math.random() * 1500);
  pollHandle = setTimeout(async () => {
    await checkParticipantState();
    if (!quizInProgress && participantId) {
      scheduleNextPoll();
    }
  }, delay);
}

async function checkParticipantState() {
  if (!participantId || quizInProgress) return;
  try {
    const state = await api(`/public/participant/${participantId}/state`);
    if (state.status === 'closed') {
      showWaitingPanel();
      $('#waiting-status').textContent = 'Đang chờ admin mở bài';
    } else if (state.status === 'open' && state.questions && !state.submitted) {
      clearTimeout(pollHandle);
      $('#waiting-panel').classList.add('hidden');
      $('#join-panel').classList.add('hidden');
      $('#quiz-panel').classList.remove('hidden');
      $('#quiz-title').textContent = state.title || 'Quiz Mini';
      startQuizRunner(state.questions);
    } else if (state.status === 'finished' && !state.submitted) {
      $('#waiting-status').textContent = 'Quiz đã kết thúc';
      $('#waiting-description').textContent = 'Admin đã kết thúc bài quiz.';
    }

    if (state.submitted && state.result) {
      clearTimeout(pollHandle);
      showResult(state.result.score, state.result.total_questions, state.result.review || []);
    }
  } catch (err) {
    console.error('Check state error:', err);
    if (err.message && err.message.includes('Không tìm thấy')) {
      resetParticipantSession();
    }
  }
}

// INTERACTIVE STEP-BY-STEP QUIZ RUNNER
function startQuizRunner(questions) {
  quizInProgress = true;
  currentQuestions = questions || [];
  currentQuestionIndex = 0;
  collectedAnswers = [];
  showCurrentQuestion();
}

function showCurrentQuestion() {
  clearInterval(questionTimerInterval);
  isAnswerLocked = false;

  if (currentQuestionIndex >= currentQuestions.length) {
    submitFinalAnswers();
    return;
  }

  const q = currentQuestions[currentQuestionIndex];
  const timeLimitSec = Number(q.time_limit) || 20;
  questionTimeLimitMs = timeLimitSec * 1000;
  currentQuestionMaxPoints = Number(q.points) || 10;
  questionStartTime = Date.now();

  const container = $('#questions-container');
  container.innerHTML = `
    <article class="step-question-card">
      <div class="step-question-meta">
        <span class="question-number">CÂU HỎI ${currentQuestionIndex + 1} / ${currentQuestions.length}</span>
        <span class="step-tag" style="background:#f1f5f9; padding:4px 10px; border-radius:99px;">Điểm tối đa: ${currentQuestionMaxPoints}đ</span>
      </div>
      <h3 style="font-size:19px; line-height:1.55; margin:0 0 16px;">${escapeHtml(q.question_text)}</h3>
      
      <div class="step-options-grid">
        ${[['A', q.option_a], ['B', q.option_b], ['C', q.option_c], ['D', q.option_d]].map(([key, val]) => `
          <button type="button" class="step-option-btn" data-key="${key}">
            <span class="step-option-key">${key}</span>
            <span style="flex:1;">${escapeHtml(val)}</span>
          </button>
        `).join('')}
      </div>

      <div style="margin-top:20px; display:flex; justify-content:flex-end;">
        <button type="button" class="mini-btn skip-question-btn" style="color:var(--muted);">Bỏ qua câu này ⏭️</button>
      </div>
    </article>
  `;

  // Attach click listener for options
  container.querySelectorAll('.step-option-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (isAnswerLocked) return;
      isAnswerLocked = true;
      clearInterval(questionTimerInterval);

      const key = btn.dataset.key;
      let timeSpentMs = Date.now() - questionStartTime;
      if (timeSpentMs > questionTimeLimitMs) timeSpentMs = questionTimeLimitMs;

      btn.classList.add('selected');
      collectedAnswers.push({
        question_id: q.id,
        selected_option: key,
        time_spent_ms: timeSpentMs
      });

      setTimeout(() => {
        currentQuestionIndex++;
        showCurrentQuestion();
      }, 350);
    });
  });

  // Attach click listener for skip button
  const skipBtn = container.querySelector('.skip-question-btn');
  if (skipBtn) {
    skipBtn.addEventListener('click', () => {
      if (isAnswerLocked) return;
      isAnswerLocked = true;
      clearInterval(questionTimerInterval);

      collectedAnswers.push({
        question_id: q.id,
        selected_option: null,
        time_spent_ms: questionTimeLimitMs
      });

      currentQuestionIndex++;
      showCurrentQuestion();
    });
  }

  // Start real-time countdown timer (mili-giây)
  updateTimerUI(questionTimeLimitMs, questionTimeLimitMs);

  questionTimerInterval = setInterval(() => {
    const elapsed = Date.now() - questionStartTime;
    const remaining = Math.max(0, questionTimeLimitMs - elapsed);

    updateTimerUI(remaining, questionTimeLimitMs);

    if (remaining <= 0) {
      // Hết thời gian cho câu hỏi này
      clearInterval(questionTimerInterval);
      if (!isAnswerLocked) {
        isAnswerLocked = true;
        container.querySelectorAll('.step-option-btn').forEach(b => b.classList.add('timeout'));

        collectedAnswers.push({
          question_id: q.id,
          selected_option: null,
          time_spent_ms: questionTimeLimitMs
        });

        const card = container.querySelector('.step-question-card');
        if (card) {
          const timeoutNotice = document.createElement('div');
          timeoutNotice.className = 'status-pill';
          timeoutNotice.style.cssText = 'background:#fee2e2; color:#b91c1c; border-color:#fca5a5; margin-top:14px;';
          timeoutNotice.innerHTML = '⚠️ Hết thời gian! Đang chuyển câu tiếp theo...';
          card.appendChild(timeoutNotice);
        }

        setTimeout(() => {
          currentQuestionIndex++;
          showCurrentQuestion();
        }, 750);
      }
    }
  }, 40);
}

function updateTimerUI(remainingMs, totalMs) {
  const secondsEl = $('#timer-seconds');
  const barFill = $('#timer-bar-fill');
  const ptsEl = $('#timer-current-pts');

  const secText = (remainingMs / 1000).toFixed(1) + 's';
  if (secondsEl) secondsEl.textContent = secText;

  const percent = totalMs > 0 ? (remainingMs / totalMs) * 100 : 0;
  if (barFill) barFill.style.width = percent + '%';

  if (ptsEl) {
    const ratio = totalMs > 0 ? remainingMs / totalMs : 0;
    const currentPts = Math.max(0.5, Math.round(currentQuestionMaxPoints * ratio * 10) / 10);
    ptsEl.textContent = remainingMs > 0 ? currentPts.toFixed(1) + 'đ' : '0.0đ';
  }
}

async function submitFinalAnswers() {
  clearInterval(questionTimerInterval);
  quizInProgress = false;

  const container = $('#questions-container');
  if (container) {
    container.innerHTML = `
      <div class="center" style="padding:40px 20px;">
        <div class="waiting-orbit"><span>⏳</span></div>
        <h2>Đang tính điểm bài làm...</h2>
        <p class="muted">Hệ thống đang đối chiếu đáp án và thời gian làm bài của bạn.</p>
      </div>
    `;
  }

  try {
    const result = await api(`/public/participant/${participantId}/submit`, {
      method: 'POST',
      body: JSON.stringify({ answers: collectedAnswers })
    });
    showResult(result.score, result.total_questions, result.review || []);
  } catch (err) {
    alert(err.message);
  }
}

// SHOW RESULT & REVIEW
let currentReview = [];
let currentReviewFilter = 'all';

function showResult(score, total, review = []) {
  clearInterval(pollHandle);
  clearInterval(questionTimerInterval);
  quizInProgress = false;

  $('#quiz-panel').classList.add('hidden');
  $('#waiting-panel').classList.add('hidden');
  $('#join-panel').classList.add('hidden');
  $('#result-panel').classList.remove('hidden');

  $('#result-score').textContent = Number(score || 0).toFixed(1);
  $('#result-detail').textContent = `Thí sinh: ${participantName || 'Bạn'} (${participantMssv || 'MSSV'}) · Tổng số câu hỏi: ${total}.`;

  currentReview = review;
  const wrongCount = review.filter(r => !r.is_correct).length;
  $('#wrong-count-badge').textContent = wrongCount;
  $('#total-questions-badge').textContent = review.length;

  renderReviewCards('all');
}

function renderReviewCards(filter = 'all') {
  currentReviewFilter = filter;
  $$('.review-filter-btn').forEach(btn => btn.classList.toggle('active', btn.dataset.filter === filter));

  const container = $('#review-container');
  if (!container) return;

  const items = filter === 'wrong' ? currentReview.filter(r => !r.is_correct) : currentReview;

  if (items.length === 0) {
    if (filter === 'wrong') {
      container.innerHTML = '<p class="status-pill" style="margin:20px 0;"><span class="live-dot"></span> Xuất sắc! Bạn không làm sai câu nào.</p>';
    } else {
      container.innerHTML = '<p class="muted">Không có thông tin câu hỏi.</p>';
    }
    return;
  }

  container.innerHTML = items.map((q, idx) => {
    const isCorrect = q.is_correct;
    const timeSpentSec = q.time_spent_ms ? (q.time_spent_ms / 1000).toFixed(1) : '0.0';
    const optList = [
      { key: 'A', text: q.option_a },
      { key: 'B', text: q.option_b },
      { key: 'C', text: q.option_c },
      { key: 'D', text: q.option_d }
    ];

    return `
      <div class="review-card ${isCorrect ? 'is-correct' : 'is-wrong'}">
        <div class="review-card-head">
          <span class="question-number">CÂU ${idx + 1} (${timeSpentSec}s / ${q.time_limit || 20}s)</span>
          <span class="review-tag ${isCorrect ? 'tag-correct' : 'tag-wrong'}">
            ${isCorrect ? `✓ ĐÚNG (+${Number(q.points_awarded || q.points).toFixed(1)} điểm)` : `✗ LÀM SAI (0 điểm)`}
          </span>
        </div>
        <h3 style="margin-bottom:14px;">${escapeHtml(q.question_text)}</h3>
        <div class="review-options-list">
          ${optList.map(opt => {
            const isCorrectOpt = opt.key === q.correct_option;
            const isUserSelected = opt.key === q.selected_option;
            let optClass = 'review-opt';
            let badgeHtml = '';

            if (isCorrectOpt) {
              optClass += ' opt-correct';
              badgeHtml = isUserSelected
                ? '<span class="opt-badge badge-correct">✓ Bạn đã chọn đúng</span>'
                : '<span class="opt-badge badge-correct">✓ Đáp án đúng</span>';
            } else if (isUserSelected) {
              optClass += ' opt-wrong-selected';
              badgeHtml = '<span class="opt-badge badge-wrong">✗ Bạn đã chọn câu này</span>';
            }

            return `
              <div class="${optClass}">
                <div><b>${opt.key}.</b> ${escapeHtml(opt.text)}</div>
                ${badgeHtml}
              </div>
            `;
          }).join('')}
        </div>
        ${q.is_timeout ? '<p class="muted small" style="margin-top:10px; color:#cf1322;">⏱️ Hết thời gian câu hỏi (quá ' + (q.time_limit || 20) + ' giây) nên không được cộng điểm.</p>' : ''}
        ${!q.selected_option && !q.is_timeout ? '<p class="muted small" style="margin-top:10px; color:#cf1322;">⚠️ Bạn chưa chọn đáp án cho câu hỏi này.</p>' : ''}
      </div>
    `;
  }).join('');
}

$$('.review-filter-btn').forEach(btn => {
  btn.addEventListener('click', () => renderReviewCards(btn.dataset.filter));
});

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ADMIN AUTHENTICATION
$('#admin-login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = new FormData(e.currentTarget);
  try {
    const res = await fetch(`${BACKEND_URL}/api/auth/admin-login`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: form.get('username'), password: form.get('password') })
    });
    const d = await res.json();
    if (!res.ok) throw new Error(d.message);
    showMessage('#admin-login-message', '');
    await loadAdmin();
  } catch (err) {
    showMessage('#admin-login-message', err.message);
  }
});

async function checkAdmin() {
  try {
    const me = await fetch(`${BACKEND_URL}/api/auth/me`, { credentials: 'include' }).then(r => r.json());
    if (me.role === 'admin') {
      await loadAdmin();
    } else {
      $('#admin-login-panel').classList.remove('hidden');
      $('#admin-dashboard').classList.add('hidden');
    }
  } catch {
    $('#admin-login-panel').classList.remove('hidden');
  }
}

async function loadAdmin() {
  $('#admin-login-panel').classList.add('hidden');
  $('#admin-dashboard').classList.remove('hidden');
  setAdminSubView(adminCurrentSubView || 'admin-page-quizzes');
  await loadQuizzes();
}

function setAdminSubView(subviewId) {
  adminCurrentSubView = subviewId;
  localStorage.setItem('quiz_admin_subview', subviewId);
  $$('.admin-subpage').forEach(el => el.classList.toggle('hidden', el.id !== subviewId));
  $$('.admin-tab-btn').forEach(btn => btn.classList.toggle('active', btn.dataset.subview === subviewId));

  if (subviewId === 'admin-page-monitor') {
    initAdminWebSocket();
    updateMonitorQuizSelect();
    if (selectedAdminQuiz) {
      $('#monitor-quiz-select').value = String(selectedAdminQuiz);
      updateMonitorStatusBadge(selectedAdminQuiz);
      subscribeToQuiz(selectedAdminQuiz);
      loadQuizData(selectedAdminQuiz);
    }
  }
}
$$('.admin-tab-btn').forEach(btn => btn.addEventListener('click', () => setAdminSubView(btn.dataset.subview)));

$('#logout-btn').addEventListener('click', async () => {
  try {
    await fetch(`${BACKEND_URL}/api/auth/logout`, { method: 'POST', credentials: 'include' });
  } catch {}
  if (ws) { ws.close(); ws = null; }
  clearTimeout(wsReconnectTimer);
  resetQuizForm();
  $('#admin-dashboard').classList.add('hidden');
  $('#admin-login-panel').classList.remove('hidden');
});

// WEBSOCKET REALTIME CONNECTION
function initAdminWebSocket() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }
  let wsUrl;
  if (BACKEND_URL) {
    const wsProto = BACKEND_URL.startsWith('https:') ? 'wss:' : 'ws:';
    const wsHost = BACKEND_URL.replace(/^https?:\/\//, '').replace(/\/$/, '');
    wsUrl = `${wsProto}//${wsHost}/ws`;
  } else {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    wsUrl = `${protocol}//${location.host}/ws`;
  }

  setWsStatus('connecting', 'Đang kết nối Realtime...');

  try {
    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      setWsStatus('connected', 'Realtime: Đã kết nối');
      if (selectedAdminQuiz) {
        subscribeToQuiz(selectedAdminQuiz);
      }
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'quiz_update' && Number(data.quizId) === Number(selectedAdminQuiz)) {
          renderParticipants(data.participants || []);
          renderRanking(data.ranking || [], true);
          renderTopWrongQuestions(data.top_wrong || [], data.total_submitted || 0);
        }
      } catch (e) {
        console.error('Error handling WebSocket message:', e);
      }
    };

    ws.onclose = () => {
      setWsStatus('disconnected', 'Realtime: Mất kết nối (Đang thử lại...)');
      clearTimeout(wsReconnectTimer);
      if (adminCurrentSubView === 'admin-page-monitor') {
        wsReconnectTimer = setTimeout(initAdminWebSocket, 3000);
      }
    };

    ws.onerror = () => {
      ws.close();
    };
  } catch {
    setWsStatus('disconnected', 'Realtime: Lỗi kết nối');
  }
}

function setWsStatus(status, text) {
  const badge = $('#ws-status-badge');
  const textEl = $('#ws-status-text');
  if (!badge || !textEl) return;
  badge.className = `ws-badge ws-${status}`;
  textEl.textContent = text;
}

function subscribeToQuiz(quizId) {
  if (ws && ws.readyState === WebSocket.OPEN && quizId) {
    ws.send(JSON.stringify({ type: 'subscribe', quizId: Number(quizId) }));
  }
}

function updateMonitorQuizSelect() {
  const select = $('#monitor-quiz-select');
  if (!select) return;
  const currentVal = select.value;
  select.innerHTML = '<option value="">-- Chọn bài quiz để theo dõi --</option>' +
    cachedQuizzes.map(q => `<option value="${q.id}">${escapeHtml(q.title)} (${q.status === 'open' ? 'Đang mở' : q.status === 'closed' ? 'Đang khóa' : 'Đã kết thúc'})</option>`).join('');
  if (currentVal && cachedQuizzes.some(q => String(q.id) === currentVal)) {
    select.value = currentVal;
  } else if (selectedAdminQuiz && cachedQuizzes.some(q => q.id === selectedAdminQuiz)) {
    select.value = String(selectedAdminQuiz);
  }
}

function updateMonitorStatusBadge(quizId) {
  const q = cachedQuizzes.find(item => item.id === Number(quizId));
  const badge = $('#monitor-quiz-status');
  if (!badge) return;
  if (!q) {
    badge.className = 'status-label status-closed';
    badge.textContent = 'CHƯA CHỌN';
    return;
  }
  badge.className = `status-label status-${q.status}`;
  badge.textContent = q.status === 'open' ? 'ĐANG MỞ' : q.status === 'closed' ? 'ĐANG KHÓA' : 'ĐÃ KẾT THÚC';
}

$('#monitor-quiz-select').addEventListener('change', async (e) => {
  const id = Number(e.target.value);
  if (!id) {
    selectedAdminQuiz = null;
    localStorage.removeItem('quiz_selected_admin_quiz');
    resetMonitorParticipantsUI();
    $('#ranking-content').innerHTML = '<p class="muted">Chọn bài quiz để xem xếp hạng.</p>';
    $('#top-wrong-content').innerHTML = '<p class="muted">Chọn bài quiz để xem phân tích 3 câu hỏi có tỷ lệ sai nhiều nhất.</p>';
    updateMonitorStatusBadge(null);
    return;
  }
  selectedAdminQuiz = id;
  localStorage.setItem('quiz_selected_admin_quiz', id);
  updateMonitorStatusBadge(id);
  subscribeToQuiz(id);
  await loadQuizData(id);
});

// ADMIN QUESTION BUILDER (CÓ THỜI GIAN LÀM BÀI TỪNG CÂU VÀ HỖ TRỢ CHỈNH SỬA)
function addQuestionEditor(q = null) {
  editorCount++;
  const id = editorCount;
  const node = document.createElement('div');
  node.className = 'question-editor-item';
  node.dataset.question = id;
  if (q && q.id) {
    node.dataset.questionDbId = q.id;
  }

  const defaultText = q ? (q.question_text || '') : '';
  const defaultA = q ? (q.option_a || '') : '';
  const defaultB = q ? (q.option_b || '') : '';
  const defaultC = q ? (q.option_c || '') : '';
  const defaultD = q ? (q.option_d || '') : '';
  const defaultOpt = q ? (q.correct_option || 'A') : 'A';
  const defaultPoints = q ? (q.points ?? 10) : 10;
  const defaultTime = q ? (q.time_limit ?? 20) : 20;

  node.innerHTML = `
    <div class="question-editor-head">
      <span>CÂU HỎI ${id}</span>
      <button type="button" class="remove-question">Xóa</button>
    </div>
    <label>Nội dung câu hỏi</label>
    <textarea data-field="question_text" maxlength="1000" required placeholder="Nhập nội dung câu hỏi"></textarea>
    <div class="editor-options">
      <input data-field="option_a" required placeholder="Đáp án A">
      <input data-field="option_b" required placeholder="Đáp án B">
      <input data-field="option_c" required placeholder="Đáp án C">
      <input data-field="option_d" required placeholder="Đáp án D">
    </div>
    <div class="editor-row" style="grid-template-columns: 1fr 1fr 1fr; margin-top: 10px;">
      <div>
        <label>Đáp án đúng</label>
        <select data-field="correct_option">
          <option value="A">A</option>
          <option value="B">B</option>
          <option value="C">C</option>
          <option value="D">D</option>
        </select>
      </div>
      <div>
        <label>Điểm</label>
        <input data-field="points" type="number" min="1" max="1000" value="10" required>
      </div>
      <div>
        <label>Thời gian (giây)</label>
        <input data-field="time_limit" type="number" min="5" max="300" value="20" required title="Thời gian trả lời câu hỏi">
      </div>
    </div>
  `;

  node.querySelector('[data-field="question_text"]').value = defaultText;
  node.querySelector('[data-field="option_a"]').value = defaultA;
  node.querySelector('[data-field="option_b"]').value = defaultB;
  node.querySelector('[data-field="option_c"]').value = defaultC;
  node.querySelector('[data-field="option_d"]').value = defaultD;
  node.querySelector('[data-field="correct_option"]').value = defaultOpt;
  node.querySelector('[data-field="points"]').value = defaultPoints;
  node.querySelector('[data-field="time_limit"]').value = defaultTime;

  node.querySelector('.remove-question').addEventListener('click', () => {
    if ($$('.question-editor-item').length <= 1) return alert('Quiz cần ít nhất một câu hỏi.');
    node.remove();
    renumberEditors();
  });

  $('#question-editor').appendChild(node);
}

function renumberEditors() {
  $$('.question-editor-item').forEach((el, i) => {
    el.querySelector('.question-editor-head span').textContent = `CÂU HỎI ${i + 1}`;
  });
}

function populateQuizForm(quiz, questions) {
  editingQuizId = quiz.id;
  showMessage('#create-message', '');

  const stepTag = $('#quiz-form-step-tag');
  const heading = $('#quiz-form-heading');
  const submitBtn = $('#quiz-submit-btn');
  const cancelBtn = $('#cancel-edit-btn');

  if (stepTag) stepTag.textContent = `01 / DỮ LIỆU & CHỈNH SỬA (ID: #${quiz.id})`;
  if (heading) heading.textContent = `Sửa quiz: ${quiz.title}`;
  if (submitBtn) submitBtn.innerHTML = 'Lưu thay đổi <span>✓</span>';
  if (cancelBtn) cancelBtn.classList.remove('hidden');

  const formEl = $('#create-quiz-form');
  formEl.querySelector('input[name="title"]').value = quiz.title || '';
  formEl.querySelector('input[name="description"]').value = quiz.description || '';

  $('#question-editor').innerHTML = '';
  editorCount = 0;
  if (Array.isArray(questions) && questions.length > 0) {
    questions.forEach(q => addQuestionEditor(q));
  } else {
    addQuestionEditor();
  }

  $$('.quiz-item').forEach(el => {
    el.classList.toggle('is-editing', Number(el.dataset.id) === quiz.id);
  });

  const formPanel = $('#quiz-form-panel');
  if (formPanel) {
    formPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

function resetQuizForm() {
  editingQuizId = null;
  showMessage('#create-message', '');

  const stepTag = $('#quiz-form-step-tag');
  const heading = $('#quiz-form-heading');
  const submitBtn = $('#quiz-submit-btn');
  const cancelBtn = $('#cancel-edit-btn');

  if (stepTag) stepTag.textContent = '01 / THIẾT LẬP';
  if (heading) heading.textContent = 'Tạo quiz mới';
  if (submitBtn) submitBtn.innerHTML = 'Tạo quiz <span>→</span>';
  if (cancelBtn) cancelBtn.classList.add('hidden');

  const formEl = $('#create-quiz-form');
  formEl.reset();
  $('#question-editor').innerHTML = '';
  editorCount = 0;
  addQuestionEditor();

  $$('.quiz-item').forEach(el => el.classList.remove('is-editing'));
}

$('#add-question-btn').addEventListener('click', () => addQuestionEditor());
const cancelEditBtn = $('#cancel-edit-btn');
if (cancelEditBtn) cancelEditBtn.addEventListener('click', resetQuizForm);
addQuestionEditor();

// CHỨC NĂNG NHẬP QUIZ TỪ FILE TEXT (.TXT) THEO ĐỊNH DẠNG QUY ĐỊNH
function parseQuizText(text) {
  if (!text || !text.trim()) {
    throw new Error('File rỗng hoặc không có nội dung text.');
  }

  const lines = text.split(/\r?\n/);
  let title = '';
  let description = '';
  const questions = [];
  let currentQ = null;

  const isQuestionStart = (line) => /^câu\s*(?:hỏi)?\s*\d+\s*[:\.]/i.test(line.trim());
  const isOptionA = (line) => /^\*?\s*A[\.\)\:\-]\s*/i.test(line.trim());
  const isOptionB = (line) => /^\*?\s*B[\.\)\:\-]\s*/i.test(line.trim());
  const isOptionC = (line) => /^\*?\s*C[\.\)\:\-]\s*/i.test(line.trim());
  const isOptionD = (line) => /^\*?\s*D[\.\)\:\-]\s*/i.test(line.trim());
  const isCorrectAnswer = (line) => /^(?:đáp\s*án\s*đúng|đáp\s*án|dap\s*an\s*dung|dap\s*an|answer|correct)\s*[:\.]/i.test(line.trim());
  const isPoints = (line) => /^(?:điểm|diem|points?)\s*[:\.]/i.test(line.trim());
  const isTimeLimit = (line) => /^(?:thời\s*gian|thoi\s*gian|time(?:\s*limit)?)\s*(?:\(giây\))?\s*[:\.]/i.test(line.trim());
  const isTitle = (line) => /^(?:tên\s*quiz|ten\s*quiz|tên\s*bài|title)\s*[:\.]/i.test(line.trim());
  const isDesc = (line) => /^(?:mô\s*tả\s*ngắn|mo\s*ta\s*ngan|mô\s*tả|mo\s*ta|description)\s*[:\.]/i.test(line.trim());

  let lineIdx = 0;
  while (lineIdx < lines.length) {
    const rawLine = lines[lineIdx];
    const line = rawLine.trim();

    if (!line) {
      lineIdx++;
      continue;
    }

    if (isTitle(line) && !title) {
      title = line.replace(/^(?:tên\s*quiz|ten\s*quiz|tên\s*bài|title)\s*[:\.]\s*/i, '').trim();
      lineIdx++;
      continue;
    }

    if (isDesc(line) && !description) {
      description = line.replace(/^(?:mô\s*tả\s*ngắn|mo\s*ta\s*ngan|mô\s*tả|mo\s*ta|description)\s*[:\.]\s*/i, '').trim();
      lineIdx++;
      continue;
    }

    if (isQuestionStart(line)) {
      if (currentQ) {
        validateAndPushParsedQuestion(currentQ, questions);
      }
      const qText = line.replace(/^câu\s*(?:hỏi)?\s*\d+\s*[:\.]\s*/i, '').trim();
      currentQ = {
        question_text: qText,
        option_a: '',
        option_b: '',
        option_c: '',
        option_d: '',
        correct_option: '',
        points: 10,
        time_limit: 20
      };
      lineIdx++;
      continue;
    }

    if (currentQ) {
      if (isOptionA(line)) {
        currentQ.option_a = line.replace(/^\*?\s*A[\.\)\:\-]\s*/i, '').trim();
        if (line.startsWith('*')) currentQ.correct_option = 'A';
      } else if (isOptionB(line)) {
        currentQ.option_b = line.replace(/^\*?\s*B[\.\)\:\-]\s*/i, '').trim();
        if (line.startsWith('*')) currentQ.correct_option = 'B';
      } else if (isOptionC(line)) {
        currentQ.option_c = line.replace(/^\*?\s*C[\.\)\:\-]\s*/i, '').trim();
        if (line.startsWith('*')) currentQ.correct_option = 'C';
      } else if (isOptionD(line)) {
        currentQ.option_d = line.replace(/^\*?\s*D[\.\)\:\-]\s*/i, '').trim();
        if (line.startsWith('*')) currentQ.correct_option = 'D';
      } else if (isCorrectAnswer(line)) {
        const val = line.replace(/^(?:đáp\s*án\s*đúng|đáp\s*án|dap\s*an\s*dung|dap\s*an|answer|correct)\s*[:\.]\s*/i, '').trim().toUpperCase();
        const match = val.match(/[ABCD]/);
        if (match) currentQ.correct_option = match[0];
      } else if (isPoints(line)) {
        const val = line.replace(/^(?:điểm|diem|points?)\s*[:\.]\s*/i, '').trim();
        const num = parseFloat(val);
        if (!isNaN(num) && num > 0) currentQ.points = num;
      } else if (isTimeLimit(line)) {
        const val = line.replace(/^(?:thời\s*gian|thoi\s*gian|time(?:\s*limit)?)\s*(?:\(giây\))?\s*[:\.]\s*/i, '').trim();
        const num = parseInt(val, 10);
        if (!isNaN(num) && num >= 5) currentQ.time_limit = Math.min(300, num);
      } else if (!currentQ.option_a) {
        currentQ.question_text += (currentQ.question_text ? ' ' : '') + line;
      }
    }

    lineIdx++;
  }

  if (currentQ) {
    validateAndPushParsedQuestion(currentQ, questions);
  }

  if (!title) {
    throw new Error('Không tìm thấy dòng "tên quiz: [Tên bài]" trong file.');
  }

  if (questions.length === 0) {
    throw new Error('Không tìm thấy câu hỏi nào hợp lệ theo mẫu "câu hỏi 1:", "A.", "B.", v.v.');
  }

  return { title, description, questions };
}

function validateAndPushParsedQuestion(q, questions) {
  const qNum = questions.length + 1;
  if (!q.question_text.trim()) {
    throw new Error(`Câu hỏi ${qNum} chưa có nội dung câu hỏi.`);
  }
  if (!q.option_a.trim() || !q.option_b.trim() || !q.option_c.trim() || !q.option_d.trim()) {
    throw new Error(`Câu hỏi ${qNum} ("${q.question_text.substring(0, 30)}...") chưa đủ 4 đáp án A, B, C, D.`);
  }
  if (!q.correct_option || !['A','B','C','D'].includes(q.correct_option)) {
    throw new Error(`Câu hỏi ${qNum} ("${q.question_text.substring(0, 30)}...") chưa có "Đáp án đúng:" (phải là A, B, C hoặc D).`);
  }
  questions.push(q);
}

function downloadSampleQuizFile() {
  const sampleContent = `tên quiz: Kiểm tra kiến thức công nghệ
mô tả ngắn: Đề thi trắc nghiệm căn bản 15 phút

câu hỏi 1: Ngôn ngữ nào sau đây được sử dụng phổ biến nhất để xây dựng giao diện tương tác trên trình duyệt web?
A. Python
B. JavaScript
C. C++
D. Java
Đáp án đúng: B
Điểm: 10
Thời gian: 20

câu hỏi 2: Giao thức mạng nào mã hóa dữ liệu truyền tải giữa trình duyệt và máy chủ (SSL/TLS)?
A. HTTP
B. FTP
C. HTTPS
D. SMTP
Đáp án đúng: C
Điểm: 10
Thời gian: 15

câu hỏi 3: Trong HTML, thẻ nào dùng để tạo liên kết siêu văn bản?
A. <link>
B. <a>
C. <href>
D. <url>
Đáp án đúng: B
Điểm: 10
Thời gian: 20
`;

  const blob = new Blob([sampleContent], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'mau_quiz_chuan.txt';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// BINDING CÁC SỰ KIỆN NHẬP FILE VÀ TẢI MẪU
const btnTriggerImport = $('#btn-trigger-import-file');
const importFileInput = $('#import-quiz-file');
const btnDownloadSample = $('#btn-download-sample-file');

if (btnTriggerImport && importFileInput) {
  btnTriggerImport.addEventListener('click', () => {
    importFileInput.click();
  });

  importFileInput.addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const text = event.target.result;
        const parsed = parseQuizText(text);

        resetQuizForm();

        const formEl = $('#create-quiz-form');
        formEl.querySelector('input[name="title"]').value = parsed.title;
        formEl.querySelector('input[name="description"]').value = parsed.description || '';

        $('#question-editor').innerHTML = '';
        editorCount = 0;
        parsed.questions.forEach(q => addQuestionEditor(q));

        const stepTag = $('#quiz-form-step-tag');
        if (stepTag) stepTag.textContent = '01 / THIẾT LẬP (ĐÃ NHẬP FILE)';

        showMessage('#create-message', `✓ Đã nhập thành công ${parsed.questions.length} câu hỏi từ file "${file.name}". Hãy kiểm tra lại và nhấn "Tạo quiz" để lưu.`);
        
        const formPanel = $('#quiz-form-panel');
        if (formPanel) {
          formPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      } catch (err) {
        alert('Lỗi định dạng file text:\n' + err.message);
        showMessage('#create-message', 'Lỗi nhập file: ' + err.message);
      } finally {
        importFileInput.value = '';
      }
    };

    reader.onerror = () => {
      alert('Không thể đọc file đã chọn. Vui lòng thử lại.');
      importFileInput.value = '';
    };

    reader.readAsText(file, 'UTF-8');
  });
}

if (btnDownloadSample) {
  btnDownloadSample.addEventListener('click', downloadSampleQuizFile);
}

// CREATE / UPDATE QUIZ SUBMIT
$('#create-quiz-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  showMessage('#create-message', '');
  const formEl = e.currentTarget;
  const form = new FormData(formEl);
  const questions = $$('.question-editor-item').map(el => {
    const get = name => el.querySelector(`[data-field="${name}"]`).value.trim();
    const dbId = el.dataset.questionDbId ? Number(el.dataset.questionDbId) : null;
    const item = {
      question_text: get('question_text'),
      option_a: get('option_a'),
      option_b: get('option_b'),
      option_c: get('option_c'),
      option_d: get('option_d'),
      correct_option: get('correct_option'),
      points: Number(get('points') || 10),
      time_limit: Number(get('time_limit') || 20)
    };
    if (dbId) item.id = dbId;
    return item;
  });

  try {
    if (editingQuizId) {
      await api(`/admin/quizzes/${editingQuizId}`, {
        method: 'PUT',
        body: JSON.stringify({
          title: form.get('title'),
          description: form.get('description'),
          questions
        })
      });
      showMessage('#create-message', 'Đã cập nhật dữ liệu quiz thành công.');
      await loadQuizzes();
      const fresh = await api(`/admin/quizzes/${editingQuizId}`);
      populateQuizForm(fresh.quiz, fresh.questions);
    } else {
      await api('/admin/quizzes', {
        method: 'POST',
        body: JSON.stringify({
          title: form.get('title'),
          description: form.get('description'),
          questions
        })
      });
      showMessage('#create-message', 'Tạo quiz thành công. Quiz đang khóa; hãy nhấn “Mở quiz” khi sẵn sàng.');
      resetQuizForm();
      await loadQuizzes();
    }
  } catch (err) {
    showMessage('#create-message', err.message);
  }
});

$('#refresh-quizzes').addEventListener('click', loadQuizzes);

async function loadQuizzes() {
  try {
    const quizzes = await api('/admin/quizzes');
    cachedQuizzes = quizzes;
    updateMonitorQuizSelect();

    $('#quiz-list').innerHTML = quizzes.length ? quizzes.map(q => `
      <div class="quiz-item ${selectedAdminQuiz === q.id ? 'selected' : ''} ${editingQuizId === q.id ? 'is-editing' : ''}" data-id="${q.id}">
        <div class="quiz-item-top">
          <div>
            <h3>${escapeHtml(q.title)}</h3>
            <div class="quiz-meta">${q.question_count} câu · ${q.participant_count} người tham gia</div>
          </div>
          <span class="status-label status-${q.status}">${q.status === 'open' ? 'ĐANG MỞ' : q.status === 'closed' ? 'ĐANG KHÓA' : 'ĐÃ KẾT THÚC'}</span>
        </div>
        <div class="quiz-actions">
          <button class="mini-btn view-action" data-action="view-data" data-id="${q.id}">👁️ Xem dữ liệu</button>
          ${q.status === 'open' ? `<button class="mini-btn lock-action" data-action="close" data-id="${q.id}">Khóa quiz</button>` : `<button class="mini-btn open-action" data-action="open" data-id="${q.id}">Mở quiz</button>`}
          ${q.status !== 'finished' ? `<button class="mini-btn" data-action="finish" data-id="${q.id}">Kết thúc</button>` : ''}
          <button class="mini-btn delete-action" data-action="delete" data-id="${q.id}">🗑️ Xóa</button>
        </div>
      </div>`).join('') : '<p class="empty">Chưa có quiz. Hãy tạo bài đầu tiên.</p>';

    $('#quiz-list').querySelectorAll('button[data-action]').forEach(btn => {
      btn.addEventListener('click', () => quizAction(btn.dataset.action, Number(btn.dataset.id)));
    });
  } catch (err) {
    $('#quiz-list').innerHTML = `<p class="message">${escapeHtml(err.message)}</p>`;
  }
}

async function quizAction(action, id) {
  if (action === 'view-data') {
    try {
      const data = await api(`/admin/quizzes/${id}`);
      populateQuizForm(data.quiz, data.questions);
    } catch (err) {
      alert('Không thể tải dữ liệu quiz: ' + err.message);
    }
    return;
  }

  if (action === 'delete') {
    const q = cachedQuizzes.find(item => item.id === id);
    const title = q ? q.title : `#${id}`;
    if (!confirm(`Bạn có chắc chắn muốn xóa bài quiz "${title}" không?\n\nLưu ý: Toàn bộ câu hỏi, lịch sử làm bài và người tham gia của bài quiz này sẽ bị xóa vĩnh viễn!`)) {
      return;
    }

    try {
      await api(`/admin/quizzes/${id}`, { method: 'DELETE' });
      if (editingQuizId === id) {
        resetQuizForm();
      }
      if (selectedAdminQuiz === id) {
        selectedAdminQuiz = null;
        localStorage.removeItem('quiz_selected_admin_quiz');
        updateMonitorStatusBadge(null);
        resetMonitorParticipantsUI();
        $('#ranking-content').innerHTML = '<p class="muted">Chọn bài quiz để xem xếp hạng.</p>';
        $('#top-wrong-content').innerHTML = '<p class="muted">Chọn bài quiz để xem phân tích 3 câu hỏi có tỷ lệ sai nhiều nhất.</p>';
      }
      await loadQuizzes();
    } catch (err) {
      alert('Xóa quiz thất bại: ' + err.message);
    }
    return;
  }

  const status = action === 'open' ? 'open' : action === 'close' ? 'closed' : 'finished';
  const confirmText = status === 'open' ? 'Mở quiz cho tất cả người đang chờ?' : status === 'closed' ? 'Khóa quiz? Người chưa nộp sẽ không thể nộp bài khi khóa.' : 'Kết thúc quiz?';
  if (!confirm(confirmText)) return;

  try {
    await api(`/admin/quizzes/${id}/status`, { method: 'POST', body: JSON.stringify({ status }) });
    await loadQuizzes();
    if (selectedAdminQuiz === id) {
      updateMonitorStatusBadge(id);
      await loadQuizData(id);
    }
  } catch (err) {
    alert(err.message);
  }
}

async function loadQuizData(id) {
  try {
    const [people, ranking, topWrong] = await Promise.all([
      api(`/admin/quizzes/${id}/participants`),
      api(`/admin/quizzes/${id}/ranking`),
      api(`/admin/quizzes/${id}/top-wrong`).catch(() => ({ total_submitted: 0, questions: [] }))
    ]);
    renderParticipants(people);
    renderRanking(ranking);
    renderTopWrongQuestions(topWrong.questions || [], topWrong.total_submitted || 0);
  } catch (err) {
    const pContent = $('#participants-content');
    if (pContent) pContent.innerHTML = `<p class="message">${escapeHtml(err.message)}</p>`;
  }
}

// BIẾN TRẠNG THÁI BỘ LỌC THÍ SINH
let currentParticipantsList = [];
let currentParticipantsFilter = 'all'; // 'all' | 'pending' | 'completed'
let currentParticipantsSearch = '';

// BẢNG NGƯỜI THAM DỰ & ĐẾM MẮT HOẠT ĐỘNG & TIẾN ĐỘ HOÀN THÀNH
function renderParticipants(people = []) {
  currentParticipantsList = Array.isArray(people) ? people : [];
  const total = currentParticipantsList.length;
  const completed = currentParticipantsList.filter(p => !!p.submitted_at).length;
  const pending = total - completed;

  // Cập nhật thẻ mắt người đang hoạt động
  const activeCountEl = $('#active-participants-count');
  if (activeCountEl) activeCountEl.textContent = total;
  const activeTag = $('#active-users-tag');
  if (activeTag) {
    activeTag.title = `Số thí sinh: ${total} (${pending} chưa xong, ${completed} đã xong). Bấm để xem danh sách.`;
  }

  // Cập nhật thẻ số người hoàn thành 0/tổng
  const completedCountEl = $('#completed-count');
  if (completedCountEl) completedCountEl.textContent = completed;
  const totalCountEl = $('#total-count');
  if (totalCountEl) totalCountEl.textContent = total;
  const completedTag = $('#completed-users-tag');
  if (completedTag) {
    const pct = total > 0 ? Math.round((completed / total) * 100) : 0;
    completedTag.title = `Tiến độ: ${completed}/${total} thí sinh đã nộp bài (${pct}%). Bấm để lọc danh sách.`;
  }

  // Cập nhật các badge số lượng trên modal toolbar
  const pBadge = $('#participant-count-badge');
  if (pBadge) pBadge.textContent = total;
  const filterAllCount = $('#filter-all-count');
  if (filterAllCount) filterAllCount.textContent = total;
  const filterPendingCount = $('#filter-pending-count');
  if (filterPendingCount) filterPendingCount.textContent = pending;
  const filterCompletedCount = $('#filter-completed-count');
  if (filterCompletedCount) filterCompletedCount.textContent = completed;

  // Render danh sách thí sinh có lọc
  applyParticipantsFilterAndRender();
}

function applyParticipantsFilterAndRender() {
  const pContent = $('#participants-content');
  if (!pContent) return;

  if (!currentParticipantsList.length) {
    pContent.innerHTML = '<p class="empty">Chưa có người tham gia bài quiz này.</p>';
    return;
  }

  const query = (currentParticipantsSearch || '').toLowerCase().trim();
  let filtered = currentParticipantsList.slice();

  // 1. Lọc theo tab tiến độ: Tất cả / Chưa làm xong / Đã làm xong
  if (currentParticipantsFilter === 'pending') {
    filtered = filtered.filter(p => !p.submitted_at);
  } else if (currentParticipantsFilter === 'completed') {
    filtered = filtered.filter(p => !!p.submitted_at);
  }

  // 2. Lọc theo từ khóa tìm kiếm (Họ tên hoặc MSSV)
  if (query) {
    filtered = filtered.filter(p => {
      const name = (p.full_name || '').toLowerCase();
      const mssv = (p.mssv || p.candidate_number || '').toLowerCase();
      return name.includes(query) || mssv.includes(query);
    });
  }

  if (!filtered.length) {
    pContent.innerHTML = `
      <div class="empty" style="padding: 24px 10px; text-align: center;">
        <p style="margin: 0 0 8px;">Không tìm thấy thí sinh nào khớp với bộ lọc.</p>
        <button type="button" class="mini-btn reset-filter-btn" style="padding: 5px 12px; font-size: 12px;">✕ Xóa bộ lọc & tìm kiếm</button>
      </div>`;
    const resetBtn = pContent.querySelector('.reset-filter-btn');
    if (resetBtn) {
      resetBtn.addEventListener('click', () => {
        currentParticipantsFilter = 'all';
        currentParticipantsSearch = '';
        const searchInput = $('#participant-search-input');
        if (searchInput) searchInput.value = '';
        $$('.modal-tab-btn').forEach(btn => btn.classList.toggle('active', btn.dataset.filter === 'all'));
        applyParticipantsFilterAndRender();
      });
    }
    return;
  }

  pContent.innerHTML = `
    <table>
      <thead>
        <tr>
          <th style="width: 45px;">STT</th>
          <th>Họ và tên</th>
          <th>MSSV</th>
          <th>Trạng thái</th>
          <th>Điểm</th>
        </tr>
      </thead>
      <tbody>
        ${filtered.map((p, idx) => `
          <tr>
            <td><span class="muted small">${idx + 1}</span></td>
            <td><strong>${escapeHtml(p.full_name)}</strong></td>
            <td><code>${escapeHtml(p.mssv || p.candidate_number)}</code></td>
            <td>
              <span class="status-label ${p.submitted_at ? 'status-open' : 'status-closed'}">
                ${p.submitted_at ? '✓ Đã xong' : '⏳ Chưa xong'}
              </span>
            </td>
            <td>${p.submitted_at ? `<strong>${Number(p.score || 0).toFixed(1)}</strong>` : '-'}</td>
          </tr>`).join('')}
      </tbody>
    </table>`;
}

function resetMonitorParticipantsUI() {
  currentParticipantsList = [];
  currentParticipantsFilter = 'all';
  currentParticipantsSearch = '';
  const searchInput = $('#participant-search-input');
  if (searchInput) searchInput.value = '';
  $$('.modal-tab-btn').forEach(btn => btn.classList.toggle('active', btn.dataset.filter === 'all'));

  if ($('#active-participants-count')) $('#active-participants-count').textContent = '0';
  if ($('#completed-count')) $('#completed-count').textContent = '0';
  if ($('#total-count')) $('#total-count').textContent = '0';
  if ($('#participant-count-badge')) $('#participant-count-badge').textContent = '0';
  if ($('#filter-all-count')) $('#filter-all-count').textContent = '0';
  if ($('#filter-pending-count')) $('#filter-pending-count').textContent = '0';
  if ($('#filter-completed-count')) $('#filter-completed-count').textContent = '0';
  if ($('#participants-content')) $('#participants-content').innerHTML = '<p class="muted">Chọn bài quiz để xem danh sách thí sinh.</p>';
}

// BẢNG XẾP HẠNG (CLICK VÀO TÊN ĐỂ HIỆN MSSV)
function renderRanking(ranking, flash = false) {
  $('#ranking-content').innerHTML = ranking.length ? ranking.map((r, i) => {
    const mssvVal = r.mssv || r.candidate_number || '';
    const isOpen = !!openRankMssv[mssvVal];
    return `
      <div class="rank-row ${flash && i < 3 ? 'flash-rank' : ''}" data-mssv="${escapeHtml(mssvVal)}" title="Bấm để xem/ẩn MSSV">
        <div class="rank-no">${i + 1}</div>
        <div class="rank-info" style="flex:1;">
          <div class="rank-name">
            <strong>${escapeHtml(r.name)}</strong>
            <span class="rank-click-hint">🔍 MSSV</span>
          </div>
          <div class="rank-mssv-tag ${isOpen ? '' : 'hidden'}">
            <span class="mssv-badge">MSSV: <b>${escapeHtml(mssvVal || 'Chưa cập nhật')}</b></span>
          </div>
        </div>
        <div class="rank-score">${Number(r.score || 0).toFixed(1)} điểm</div>
      </div>
    `;
  }).join('') : '<p class="empty">Chưa có kết quả nộp bài.</p>';

  // Gắn sự kiện click toggle xem MSSV
  $$('#ranking-content .rank-row').forEach(row => {
    row.addEventListener('click', () => {
      const mssv = row.dataset.mssv;
      const tag = row.querySelector('.rank-mssv-tag');
      if (tag) {
        tag.classList.toggle('hidden');
        openRankMssv[mssv] = !tag.classList.contains('hidden');
      }
    });
  });
}

// TOP 3 CÂU HỎI SAI NHIỀU NHẤT
function renderTopWrongQuestions(questions, totalSubmitted) {
  const container = $('#top-wrong-content');
  if (!container) return;
  if (!totalSubmitted || !questions || questions.length === 0) {
    container.innerHTML = '<p class="muted">Chưa có đủ dữ liệu thí sinh nộp bài để thống kê các câu hỏi sai.</p>';
    return;
  }
  container.innerHTML = questions.map((q, idx) => {
    const rank = idx + 1;
    const correctOptKey = (q.correct_option || 'A').toLowerCase();
    const correctOptText = q['option_' + correctOptKey] || '';
    return `
      <div class="wrong-card">
        <div>
          <div class="wrong-card-head">
            <span class="wrong-badge">#${rank} SAI NHIỀU NHẤT</span>
            <span class="wrong-rate-text">${q.wrong_rate}% LÀM SAI</span>
          </div>
          <div class="wrong-progress-bar">
            <div class="wrong-progress-fill" style="width: ${q.wrong_rate}%;"></div>
          </div>
          <p class="wrong-question-text">${escapeHtml(q.question_text)}</p>
        </div>
        <div>
          <div class="muted small" style="margin-bottom: 8px;">
            <b>${q.wrong_count}/${totalSubmitted}</b> thí sinh trả lời sai
          </div>
          <div class="wrong-correct-box">
            <span>Đáp án đúng:</span> <b>${q.correct_option}.</b> ${escapeHtml(correctOptText)}
          </div>
        </div>
      </div>
    `;
  }).join('');
}

// MODAL QUẢN LÝ DANH SÁCH THÍ SINH & BỘ LỌC
function initParticipantsModal() {
  const activeTag = $('#active-users-tag');
  const completedTag = $('#completed-users-tag');
  const modal = $('#participants-modal');
  const closeBtn = $('#close-participants-modal');
  const searchInput = $('#participant-search-input');
  const tabBtns = $$('.modal-tab-btn');

  function openModal(defaultFilter = null) {
    if (defaultFilter) {
      currentParticipantsFilter = defaultFilter;
      tabBtns.forEach(btn => btn.classList.toggle('active', btn.dataset.filter === defaultFilter));
    }
    applyParticipantsFilterAndRender();
    modal.classList.remove('hidden');
    if (searchInput) {
      setTimeout(() => searchInput.focus(), 60);
    }
  }

  if (activeTag && modal) {
    activeTag.addEventListener('click', () => openModal('all'));
    activeTag.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openModal('all'); }
    });
  }

  if (completedTag && modal) {
    completedTag.addEventListener('click', () => openModal());
    completedTag.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openModal(); }
    });
  }

  if (closeBtn && modal) {
    closeBtn.addEventListener('click', () => modal.classList.add('hidden'));
  }

  if (modal) {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) modal.classList.add('hidden');
    });
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !modal.classList.contains('hidden')) {
        modal.classList.add('hidden');
      }
    });
  }

  // Sự kiện chuyển Tab lọc: Tất cả / Chưa làm xong / Đã làm xong
  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      tabBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentParticipantsFilter = btn.dataset.filter || 'all';
      applyParticipantsFilterAndRender();
    });
  });

  // Sự kiện tìm kiếm lọc theo Họ tên hoặc MSSV
  if (searchInput) {
    searchInput.addEventListener('input', (e) => {
      currentParticipantsSearch = e.target.value;
      applyParticipantsFilterAndRender();
    });
  }
}

// KHỞI ĐỘNG ỨNG DỤNG & PHỤC HỒI TRẠNG THÁI SAU KHI RELOAD
async function initApp() {
  initParticipantsModal();
  const activeView = localStorage.getItem('quiz_active_view') || 'play-view';
  setView(activeView);

  // Nếu người dùng đã từng join và reload lại trang
  if (participantId) {
    showWaitingPanel();
    startPolling();
  }
}

initApp();
