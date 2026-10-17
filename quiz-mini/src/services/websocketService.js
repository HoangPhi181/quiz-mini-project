const { WebSocketServer } = require('ws');
const repo = require('../repositories/quizRepository');

let wss = null;

function initWebSocketServer(httpServer) {
  wss = new WebSocketServer({ server: httpServer, path: '/ws' });

  wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.subscribedQuizId = null;

    ws.on('pong', () => {
      ws.isAlive = true;
    });

    ws.on('message', async (message) => {
      try {
        const data = JSON.parse(message);
        if (data.type === 'subscribe' && data.quizId) {
          ws.subscribedQuizId = Number(data.quizId);
          // Gửi dữ liệu hiện tại ngay khi vừa subscribe
          await sendQuizUpdateToClient(ws, ws.subscribedQuizId);
        } else if (data.type === 'unsubscribe') {
          ws.subscribedQuizId = null;
        } else if (data.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong' }));
        }
      } catch (err) {
        console.error('WebSocket message parsing error:', err.message);
      }
    });

    ws.on('error', (err) => {
      console.error('WebSocket client error:', err.message);
    });
  });

  // Keep-alive heartbeat định kỳ mỗi 30s
  const interval = setInterval(() => {
    if (!wss) return;
    wss.clients.forEach((ws) => {
      if (ws.isAlive === false) return ws.terminate();
      ws.isAlive = false;
      ws.ping();
    });
  }, 30000);

  wss.on('close', () => {
    clearInterval(interval);
  });

  return wss;
}

async function sendQuizUpdateToClient(ws, quizId) {
  try {
    const [participants, rawRanking, topWrongData] = await Promise.all([
      repo.listParticipants(quizId),
      repo.getRanking(quizId),
      repo.getTopWrongQuestions(quizId, 3)
    ]);
    const ranking = rawRanking.map((r, i) => ({
      rank: i + 1,
      name: r.full_name,
      mssv: r.mssv || r.candidate_number,
      score: r.score,
      total_questions: r.total_questions,
      submitted_at: r.submitted_at
    }));

    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({
        type: 'quiz_update',
        quizId,
        participants,
        ranking,
        top_wrong: topWrongData.questions,
        total_submitted: topWrongData.total_submitted,
        timestamp: Date.now()
      }));
    }
  } catch (err) {
    console.error('Error fetching quiz data for client:', err.message);
  }
}

// Quản lý throttle broadcast cập nhật realtime
const broadcastTimers = new Map();

function broadcastQuizUpdate(quizId, immediate = false) {
  if (!wss || !quizId) return;
  const targetId = Number(quizId);

  if (immediate) {
    if (broadcastTimers.has(targetId)) {
      clearTimeout(broadcastTimers.get(targetId));
      broadcastTimers.delete(targetId);
    }
    return executeBroadcast(targetId);
  }

  // Nếu đang có lịch gửi trong 350ms tới thì gom chung cập nhật (Debounce/Throttle)
  if (broadcastTimers.has(targetId)) return;

  const timer = setTimeout(() => {
    broadcastTimers.delete(targetId);
    executeBroadcast(targetId);
  }, 350);
  broadcastTimers.set(targetId, timer);
}

async function executeBroadcast(targetId) {
  try {
    const [participants, rawRanking, topWrongData] = await Promise.all([
      repo.listParticipants(targetId),
      repo.getRanking(targetId),
      repo.getTopWrongQuestions(targetId, 3)
    ]);
    const ranking = rawRanking.map((r, i) => ({
      rank: i + 1,
      name: r.full_name,
      mssv: r.mssv || r.candidate_number,
      score: r.score,
      total_questions: r.total_questions,
      submitted_at: r.submitted_at
    }));

    const payload = JSON.stringify({
      type: 'quiz_update',
      quizId: targetId,
      participants,
      ranking,
      top_wrong: topWrongData.questions,
      total_submitted: topWrongData.total_submitted,
      timestamp: Date.now()
    });

    wss.clients.forEach((client) => {
      if (client.readyState === client.OPEN && client.subscribedQuizId === targetId) {
        client.send(payload);
      }
    });
  } catch (err) {
    console.error('Error broadcasting quiz update:', err.message);
  }
}

module.exports = {
  initWebSocketServer,
  broadcastQuizUpdate
};
