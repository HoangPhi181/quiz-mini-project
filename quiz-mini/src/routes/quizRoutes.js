const router = require('express').Router();
const repo = require('../repositories/quizRepository');
const requireAdmin = require('../middleware/requireAdmin');
const { broadcastQuizUpdate } = require('../services/websocketService');

const clean = v => String(v ?? '').trim();
router.get('/public/state', async (req, res, next) => {
  try {
    const quiz = await repo.getActiveQuiz();
    if (!quiz) return res.json({ quiz: null });
    res.json({ quiz: { id: quiz.id, title: quiz.title, description: quiz.description, status: quiz.status } });
  } catch (e) { next(e); }
});
router.get('/admin/quizzes', requireAdmin, async (req, res, next) => {
  try { res.json(await repo.listQuizzes()); } catch (e) { next(e); }
});
router.get('/admin/quizzes/:id', requireAdmin, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const quiz = await repo.getQuiz(id);
    if (!quiz) return res.status(404).json({ message: 'Không tìm thấy quiz.' });
    const questions = await repo.getQuestions(id, true);
    res.json({ quiz, questions });
  } catch (e) { next(e); }
});
router.post('/admin/quizzes', requireAdmin, async (req, res, next) => {
  try {
    const title = clean(req.body.title), description = clean(req.body.description);
    const questions = req.body.questions;
    if (!title) return res.status(400).json({ message: 'Vui lòng nhập tên quiz.' });
    if (!Array.isArray(questions) || !questions.length) return res.status(400).json({ message: 'Quiz cần ít nhất một câu hỏi.' });
    for (const [i, q] of questions.entries()) {
      if (![q.question_text,q.option_a,q.option_b,q.option_c,q.option_d].every(x => clean(x)) || !['A','B','C','D'].includes(q.correct_option)) {
        return res.status(400).json({ message: `Câu hỏi ${i+1} chưa đủ nội dung hoặc đáp án.` });
      }
    }
    const id = await repo.createQuiz({ title, description });
    for (const [i, q] of questions.entries()) await repo.addQuestion(id, q, i);
    res.status(201).json({ id, message: 'Đã tạo quiz.' });
  } catch (e) { next(e); }
});
router.put('/admin/quizzes/:id', requireAdmin, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const quiz = await repo.getQuiz(id);
    if (!quiz) return res.status(404).json({ message: 'Không tìm thấy quiz.' });
    const title = clean(req.body.title), description = clean(req.body.description);
    const questions = req.body.questions;
    if (!title) return res.status(400).json({ message: 'Vui lòng nhập tên quiz.' });
    if (!Array.isArray(questions) || !questions.length) return res.status(400).json({ message: 'Quiz cần ít nhất một câu hỏi.' });
    for (const [i, q] of questions.entries()) {
      if (![q.question_text,q.option_a,q.option_b,q.option_c,q.option_d].every(x => clean(x)) || !['A','B','C','D'].includes(q.correct_option)) {
        return res.status(400).json({ message: `Câu hỏi ${i+1} chưa đủ nội dung hoặc đáp án.` });
      }
    }
    await repo.updateQuiz(id, { title, description, questions });
    broadcastQuizUpdate(id);
    res.json({ id, message: 'Đã cập nhật quiz thành công.' });
  } catch (e) { next(e); }
});
router.delete('/admin/quizzes/:id', requireAdmin, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const quiz = await repo.getQuiz(id);
    if (!quiz) return res.status(404).json({ message: 'Không tìm thấy quiz.' });
    await repo.deleteQuiz(id);
    res.json({ id, message: 'Đã xóa quiz thành công.' });
  } catch (e) { next(e); }
});
router.post('/admin/quizzes/:id/status', requireAdmin, async (req, res, next) => {
  try {
    const id = Number(req.params.id), status = req.body.status;
    if (!['closed','open','finished'].includes(status)) return res.status(400).json({ message: 'Trạng thái không hợp lệ.' });
    const quiz = await repo.getQuiz(id);
    if (!quiz) return res.status(404).json({ message: 'Không tìm thấy quiz.' });
    await repo.setStatus(id, status);
    broadcastQuizUpdate(id);
    res.json({ message: status === 'open' ? 'Đã mở quiz.' : status === 'closed' ? 'Đã khóa quiz.' : 'Đã kết thúc quiz.' });
  } catch (e) { next(e); }
});
router.get('/admin/quizzes/:id/participants', requireAdmin, async (req, res, next) => {
  try {
    if (!await repo.getQuiz(Number(req.params.id))) return res.status(404).json({ message: 'Không tìm thấy quiz.' });
    res.json(await repo.listParticipants(Number(req.params.id)));
  } catch (e) { next(e); }
});
router.get('/admin/quizzes/:id/ranking', requireAdmin, async (req, res, next) => {
  try {
    res.json((await repo.getRanking(Number(req.params.id))).map((r, i) => ({
      rank: i + 1,
      name: r.full_name,
      mssv: r.mssv || r.candidate_number,
      score: r.score,
      total_questions: r.total_questions,
      submitted_at: r.submitted_at
    })));
  } catch (e) { next(e); }
});
router.get('/admin/quizzes/:id/top-wrong', requireAdmin, async (req, res, next) => {
  try {
    const data = await repo.getTopWrongQuestions(Number(req.params.id), 3);
    res.json(data);
  } catch (e) { next(e); }
});
router.post('/public/join', async (req, res, next) => {
  try {
    const fullName = clean(req.body.full_name), candidateNumber = clean(req.body.candidate_number);
    if (fullName.length < 2 || candidateNumber.length < 1) return res.status(400).json({ message: 'Vui lòng nhập họ tên và MSSV.' });
    const quiz = await repo.getActiveQuiz();
    if (!quiz) return res.status(409).json({ message: 'Admin chưa tạo quiz.' });
    if (quiz.status === 'finished') return res.status(409).json({ message: 'Quiz đã kết thúc.' });
    const id = await repo.joinParticipant(quiz.id, fullName, candidateNumber);
    broadcastQuizUpdate(quiz.id);
    res.status(201).json({ participant_id: id, quiz_id: quiz.id, message: 'Đã vào phòng chờ.' });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ message: 'MSSV này đã tham gia quiz.' });
    next(e);
  }
});
router.get('/public/participant/:id/state', async (req, res, next) => {
  try {
    const participant = await repo.getParticipant(Number(req.params.id));
    if (!participant) return res.status(404).json({ message: 'Không tìm thấy người tham gia.' });
    const quiz = await repo.getQuiz(participant.quiz_id);
    if (!quiz) return res.status(404).json({ message: 'Không tìm thấy quiz.' });
    const result = { status: quiz.status, title: quiz.title, submitted: !!participant.submitted_at };
    if (quiz.status === 'open' && !participant.submitted_at) result.questions = await repo.getQuestions(quiz.id, false);
    if (participant.submitted_at) {
      const review = await repo.getParticipantReview(participant.id, participant.quiz_id);
      result.result = { score: participant.score, total_questions: participant.total_questions, review };
    }
    res.json(result);
  } catch (e) { next(e); }
});
router.post('/public/participant/:id/submit', async (req, res, next) => {
  try {
    const participant = await repo.getParticipant(Number(req.params.id));
    if (!participant) return res.status(404).json({ message: 'Không tìm thấy người tham gia.' });
    const quiz = await repo.getQuiz(participant.quiz_id);
    if (!quiz || quiz.status !== 'open') return res.status(409).json({ message: 'Quiz chưa mở hoặc đã khóa.' });
    const answers = Array.isArray(req.body.answers) ? req.body.answers : [];
    const result = await repo.submitAnswers(participant.id, participant.quiz_id, answers);
    broadcastQuizUpdate(participant.quiz_id);
    res.json({ message: 'Nộp bài thành công.', ...result });
  } catch (e) {
    if (e.message.includes('đã nộp')) return res.status(409).json({ message: e.message });
    next(e);
  }
});
module.exports = router;
