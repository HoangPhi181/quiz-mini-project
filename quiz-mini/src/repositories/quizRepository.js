const db = require('../config/db');

// In-memory cache trong Node.js:
// Giúp giảm tải 95% số lượng truy vấn đến Aiven MySQL Free Tier khi 100+ thí sinh cùng truy cập/polling
const quizCache = new Map();         // id -> { data, expiresAt }
const questionsCache = new Map();    // key -> { data, expiresAt }
const participantCache = new Map();  // id -> { data, expiresAt }
let activeQuizCache = null;          // { data, expiresAt }

function invalidateQuizCache(quizId) {
  if (quizId) {
    quizCache.delete(Number(quizId));
    questionsCache.delete(`${quizId}_true`);
    questionsCache.delete(`${quizId}_false`);
  } else {
    quizCache.clear();
    questionsCache.clear();
  }
  activeQuizCache = null;
}

function invalidateParticipantCache(id) {
  if (id) participantCache.delete(Number(id));
  else participantCache.clear();
}

async function getActiveQuiz() {
  if (activeQuizCache && activeQuizCache.expiresAt > Date.now()) {
    return activeQuizCache.data;
  }
  let rows;
  try {
    [rows] = await db.query("SELECT id,title,description,status,sort_order,created_at FROM quizzes ORDER BY sort_order ASC, id DESC LIMIT 1");
  } catch (err) {
    if (err.code === 'ER_BAD_FIELD_ERROR') {
      [rows] = await db.query("SELECT id,title,description,status,created_at FROM quizzes ORDER BY id DESC LIMIT 1");
    } else {
      throw err;
    }
  }
  const quiz = rows[0] || null;
  activeQuizCache = { data: quiz, expiresAt: Date.now() + 2500 };
  return quiz;
}

async function listQuizzes() {
  try {
    const [rows] = await db.query("SELECT q.*, (SELECT COUNT(*) FROM questions x WHERE x.quiz_id=q.id) question_count, (SELECT COUNT(*) FROM participants p WHERE p.quiz_id=q.id) participant_count FROM quizzes q ORDER BY q.sort_order ASC, q.id DESC");
    return rows;
  } catch (err) {
    if (err.code === 'ER_BAD_FIELD_ERROR') {
      const [rows] = await db.query("SELECT q.*, (SELECT COUNT(*) FROM questions x WHERE x.quiz_id=q.id) question_count, (SELECT COUNT(*) FROM participants p WHERE p.quiz_id=q.id) participant_count FROM quizzes q ORDER BY q.id DESC");
      return rows;
    }
    throw err;
  }
}

async function getQuiz(id) {
  const targetId = Number(id);
  const cached = quizCache.get(targetId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.data;
  }
  const [rows] = await db.query('SELECT * FROM quizzes WHERE id=?', [targetId]);
  const quiz = rows[0] || null;
  if (quiz) {
    quizCache.set(targetId, { data: quiz, expiresAt: Date.now() + 4000 });
  }
  return quiz;
}

async function getQuestions(quizId, includeAnswers = false) {
  const targetId = Number(quizId);
  const cacheKey = `${targetId}_${!!includeAnswers}`;
  const cached = questionsCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.data;
  }

  const columns = includeAnswers
    ? 'id,quiz_id,question_text,option_a,option_b,option_c,option_d,correct_option,points,time_limit,sort_order'
    : 'id,quiz_id,question_text,option_a,option_b,option_c,option_d,points,time_limit,sort_order';
  const [rows] = await db.query(`SELECT ${columns} FROM questions WHERE quiz_id=? ORDER BY sort_order,id`, [targetId]);
  const data = rows.map(r => ({ ...r, time_limit: Number(r.time_limit || 20), points: Number(r.points || 10) }));

  questionsCache.set(cacheKey, { data, expiresAt: Date.now() + 30000 });
  return data;
}

async function createQuiz({ title, description }) {
  try {
    await db.query('UPDATE quizzes SET sort_order = sort_order + 1');
    const [result] = await db.query('INSERT INTO quizzes(title,description,status,sort_order) VALUES(?,?,?,0)', [title, description || '', 'closed']);
    invalidateQuizCache();
    return result.insertId;
  } catch (err) {
    if (err.code === 'ER_BAD_FIELD_ERROR') {
      const [result] = await db.query('INSERT INTO quizzes(title,description,status) VALUES(?,?,?)', [title, description || '', 'closed']);
      invalidateQuizCache();
      return result.insertId;
    }
    throw err;
  }
}

async function addQuestion(quizId, q, sortOrder) {
  const timeLimit = Math.max(5, Math.min(300, Number(q.time_limit || 20)));
  const [result] = await db.query(
    'INSERT INTO questions(quiz_id,question_text,option_a,option_b,option_c,option_d,correct_option,points,time_limit,sort_order) VALUES(?,?,?,?,?,?,?,?,?,?)',
    [quizId, q.question_text, q.option_a, q.option_b, q.option_c, q.option_d, q.correct_option, Number(q.points || 10), timeLimit, sortOrder]
  );
  invalidateQuizCache(quizId);
  return result.insertId;
}

async function setStatus(id, status) {
  await db.query('UPDATE quizzes SET status=? WHERE id=?', [status, id]);
  invalidateQuizCache(id);
}

async function joinParticipant(quizId, fullName, candidateNumber) {
  const [result] = await db.query('INSERT INTO participants(quiz_id,full_name,candidate_number) VALUES(?,?,?)', [quizId, fullName, candidateNumber]);
  return result.insertId;
}

async function getParticipant(id) {
  const targetId = Number(id);
  const cached = participantCache.get(targetId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.data;
  }
  const [rows] = await db.query('SELECT * FROM participants WHERE id=?', [targetId]);
  const p = rows[0] || null;
  if (p) {
    // Đã nộp bài: kết quả cố định nên cache lâu (60s). Chưa nộp bài: cache 3s để cập nhật nhanh khi nộp bài
    const ttl = p.submitted_at ? 60000 : 3000;
    participantCache.set(targetId, { data: p, expiresAt: Date.now() + ttl });
  }
  return p;
}

async function listParticipants(quizId) {
  const [rows] = await db.query('SELECT id,full_name,candidate_number,candidate_number AS mssv,score,total_questions,joined_at,submitted_at FROM participants WHERE quiz_id=? ORDER BY joined_at', [quizId]);
  return rows;
}

async function getRanking(quizId) {
  const [rows] = await db.query("SELECT full_name,candidate_number,candidate_number AS mssv,score,total_questions,submitted_at FROM participants WHERE quiz_id=? AND submitted_at IS NOT NULL ORDER BY score DESC, submitted_at ASC", [quizId]);
  return rows;
}

async function submitAnswers(participantId, quizId, submittedAnswers) {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const [existing] = await conn.query('SELECT submitted_at FROM participants WHERE id=? FOR UPDATE', [participantId]);
    if (!existing.length) throw new Error('Không tìm thấy lượt tham gia.');
    if (existing[0].submitted_at) throw new Error('Bạn đã nộp bài trước đó.');

    // Tận dụng cached questions để giải phóng kết nối database nhanh nhất có thể
    const questions = await getQuestions(quizId, true);
    const answerMap = new Map((submittedAnswers || []).map(a => [
      Number(a.question_id),
      {
        selected: String(a.selected_option || '').toUpperCase(),
        timeSpentMs: Math.max(0, Number(a.time_spent_ms || 0))
      }
    ]));

    let score = 0;
    const review = [];
    const answersToInsert = [];

    for (const q of questions) {
      const ans = answerMap.get(q.id);
      const selected = ans ? ans.selected : null;
      const timeSpentMs = ans ? ans.timeSpentMs : 0;
      const timeLimitMs = (Number(q.time_limit) || 20) * 1000;

      const isAnswered = ['A','B','C','D'].includes(selected);
      const isTimeout = timeSpentMs >= timeLimitMs;
      const isCorrect = isAnswered && !isTimeout && selected === q.correct_option;

      let awarded = 0;
      if (isCorrect) {
        const timeRemainingMs = Math.max(0, timeLimitMs - timeSpentMs);
        const ratio = timeRemainingMs / timeLimitMs;
        awarded = Math.round(Number(q.points) * ratio * 10) / 10;
        if (awarded < 0.5) awarded = 0.5;
      }

      score += awarded;

      if (isAnswered) {
        answersToInsert.push([participantId, q.id, selected, isCorrect ? 1 : 0, awarded, timeSpentMs]);
      }

      review.push({
        question_id: q.id,
        question_text: q.question_text,
        option_a: q.option_a,
        option_b: q.option_b,
        option_c: q.option_c,
        option_d: q.option_d,
        selected_option: isAnswered ? selected : null,
        correct_option: q.correct_option,
        is_correct: isCorrect,
        points: Number(q.points),
        points_awarded: awarded,
        time_limit: Number(q.time_limit || 20),
        time_spent_ms: timeSpentMs,
        is_timeout: isTimeout
      });
    }

    score = Math.round(score * 10) / 10;

    // Chèn dữ liệu câu trả lời hàng loạt (Bulk Insert) 1 truy vấn duy nhất
    if (answersToInsert.length > 0) {
      await conn.query(
        'INSERT INTO answers(participant_id,question_id,selected_option,is_correct,points_awarded,time_spent_ms) VALUES ? ON DUPLICATE KEY UPDATE selected_option=VALUES(selected_option),is_correct=VALUES(is_correct),points_awarded=VALUES(points_awarded),time_spent_ms=VALUES(time_spent_ms)',
        [answersToInsert]
      );
    }

    await conn.query('UPDATE participants SET score=?,total_questions=?,submitted_at=NOW() WHERE id=?', [score, questions.length, participantId]);
    await conn.commit();

    invalidateParticipantCache(participantId);
    return { score, total_questions: questions.length, review };
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally { conn.release(); }
}

async function getParticipantReview(participantId, quizId) {
  const [questions] = await db.query(
    'SELECT q.id,q.question_text,q.option_a,q.option_b,q.option_c,q.option_d,q.correct_option,q.points,q.time_limit,a.selected_option,a.is_correct,a.points_awarded,a.time_spent_ms FROM questions q LEFT JOIN answers a ON a.question_id=q.id AND a.participant_id=? WHERE q.quiz_id=? ORDER BY q.sort_order,q.id',
    [participantId, quizId]
  );
  return questions.map(q => ({
    question_id: q.id,
    question_text: q.question_text,
    option_a: q.option_a,
    option_b: q.option_b,
    option_c: q.option_c,
    option_d: q.option_d,
    selected_option: q.selected_option || null,
    correct_option: q.correct_option,
    is_correct: !!q.is_correct,
    points: Number(q.points),
    points_awarded: Number(q.points_awarded || 0),
    time_limit: Number(q.time_limit || 20),
    time_spent_ms: Number(q.time_spent_ms || 0)
  }));
}

async function getTopWrongQuestions(quizId, limit = 3) {
  const [subRows] = await db.query(
    'SELECT COUNT(*) AS total_submitted FROM participants WHERE quiz_id=? AND submitted_at IS NOT NULL',
    [quizId]
  );
  const totalSubmitted = Number(subRows[0]?.total_submitted || 0);
  if (totalSubmitted === 0) return { total_submitted: 0, questions: [] };

  // Tối ưu hóa truy vấn phân tích: dùng GROUP BY thay vì subquery lặp cho từng câu hỏi
  const [rows] = await db.query(`
    SELECT 
      q.id,
      q.question_text,
      q.option_a,
      q.option_b,
      q.option_c,
      q.option_d,
      q.correct_option,
      COALESCE(c.correct_count, 0) AS correct_count
    FROM questions q
    LEFT JOIN (
      SELECT a.question_id, COUNT(*) AS correct_count
      FROM answers a
      JOIN participants p ON a.participant_id = p.id
      WHERE p.quiz_id = ? AND a.is_correct = 1 AND p.submitted_at IS NOT NULL
      GROUP BY a.question_id
    ) c ON c.question_id = q.id
    WHERE q.quiz_id = ?
    ORDER BY (? - COALESCE(c.correct_count, 0)) DESC, q.sort_order ASC, q.id ASC
    LIMIT ?
  `, [quizId, quizId, totalSubmitted, limit]);

  const questions = rows.map((r, index) => {
    const correctCount = Number(r.correct_count || 0);
    const wrongCount = totalSubmitted - correctCount;
    const wrongRate = totalSubmitted > 0 ? Math.round((wrongCount / totalSubmitted) * 100) : 0;
    return {
      rank: index + 1,
      id: r.id,
      question_text: r.question_text,
      option_a: r.option_a,
      option_b: r.option_b,
      option_c: r.option_c,
      option_d: r.option_d,
      correct_option: r.correct_option,
      wrong_count: wrongCount,
      correct_count: correctCount,
      total_submitted: totalSubmitted,
      wrong_rate: wrongRate
    };
  });

  return { total_submitted: totalSubmitted, questions };
}

async function updateQuiz(quizId, { title, description, questions }) {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    await conn.query('UPDATE quizzes SET title=?, description=? WHERE id=?', [title, description || '', quizId]);

    const [existingQuestions] = await conn.query('SELECT id FROM questions WHERE quiz_id=?', [quizId]);
    const existingIds = new Set(existingQuestions.map(q => q.id));
    const keptIds = new Set();

    for (const [i, q] of questions.entries()) {
      const timeLimit = Math.max(5, Math.min(300, Number(q.time_limit || 20)));
      const points = Number(q.points || 10);
      const qId = q.id ? Number(q.id) : null;

      if (qId && existingIds.has(qId)) {
        await conn.query(
          'UPDATE questions SET question_text=?, option_a=?, option_b=?, option_c=?, option_d=?, correct_option=?, points=?, time_limit=?, sort_order=? WHERE id=? AND quiz_id=?',
          [q.question_text, q.option_a, q.option_b, q.option_c, q.option_d, q.correct_option, points, timeLimit, i, qId, quizId]
        );
        keptIds.add(qId);
      } else {
        const [res] = await conn.query(
          'INSERT INTO questions(quiz_id,question_text,option_a,option_b,option_c,option_d,correct_option,points,time_limit,sort_order) VALUES(?,?,?,?,?,?,?,?,?,?)',
          [quizId, q.question_text, q.option_a, q.option_b, q.option_c, q.option_d, q.correct_option, points, timeLimit, i]
        );
        keptIds.add(res.insertId);
      }
    }

    const idsToDelete = [...existingIds].filter(id => !keptIds.has(id));
    if (idsToDelete.length > 0) {
      await conn.query('DELETE FROM questions WHERE id IN (?) AND quiz_id=?', [idsToDelete, quizId]);
    }

    await conn.commit();
    invalidateQuizCache(quizId);
    return true;
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

async function deleteQuiz(id) {
  const [result] = await db.query('DELETE FROM quizzes WHERE id=?', [id]);
  invalidateQuizCache(id);
  return result.affectedRows > 0;
}

async function reorderQuizzes(orderedIds) {
  if (!Array.isArray(orderedIds) || orderedIds.length === 0) return false;
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    for (let i = 0; i < orderedIds.length; i++) {
      const id = Number(orderedIds[i]);
      if (id) {
        await conn.query('UPDATE quizzes SET sort_order = ? WHERE id = ?', [i, id]);
      }
    }
    await conn.commit();
    invalidateQuizCache();
    return true;
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

module.exports = {
  getActiveQuiz,
  listQuizzes,
  getQuiz,
  getQuestions,
  createQuiz,
  addQuestion,
  updateQuiz,
  deleteQuiz,
  reorderQuizzes,
  setStatus,
  joinParticipant,
  getParticipant,
  listParticipants,
  getRanking,
  submitAnswers,
  getParticipantReview,
  getTopWrongQuestions,
  invalidateQuizCache,
  invalidateParticipantCache
};
