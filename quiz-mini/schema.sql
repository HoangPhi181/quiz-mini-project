DROP DATABASE IF EXISTS quiz_mini;
CREATE DATABASE IF NOT EXISTS quiz_mini CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE quiz_mini;

CREATE TABLE IF NOT EXISTS quizzes (
  id INT AUTO_INCREMENT PRIMARY KEY,
  title VARCHAR(180) NOT NULL,
  description VARCHAR(500) DEFAULT '',
  status ENUM('closed','open','finished') NOT NULL DEFAULT 'closed',
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS questions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  quiz_id INT NOT NULL,
  question_text VARCHAR(1000) NOT NULL,
  option_a VARCHAR(500) NOT NULL,
  option_b VARCHAR(500) NOT NULL,
  option_c VARCHAR(500) NOT NULL,
  option_d VARCHAR(500) NOT NULL,
  correct_option ENUM('A','B','C','D') NOT NULL,
  points DECIMAL(10,1) NOT NULL DEFAULT 10.0,
  time_limit INT NOT NULL DEFAULT 20,
  sort_order INT NOT NULL DEFAULT 0,
  CONSTRAINT fk_questions_quiz FOREIGN KEY (quiz_id) REFERENCES quizzes(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS participants (
  id INT AUTO_INCREMENT PRIMARY KEY,
  quiz_id INT NOT NULL,
  full_name VARCHAR(120) NOT NULL,
  candidate_number VARCHAR(40) NOT NULL,
  score DECIMAL(10,1) NOT NULL DEFAULT 0.0,
  total_questions INT NOT NULL DEFAULT 0,
  joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  submitted_at TIMESTAMP NULL DEFAULT NULL,
  UNIQUE KEY unique_candidate_per_quiz (quiz_id, candidate_number),
  CONSTRAINT fk_participants_quiz FOREIGN KEY (quiz_id) REFERENCES quizzes(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS answers (
  id INT AUTO_INCREMENT PRIMARY KEY,
  participant_id INT NOT NULL,
  question_id INT NOT NULL,
  selected_option ENUM('A','B','C','D') NOT NULL,
  is_correct TINYINT(1) NOT NULL DEFAULT 0,
  points_awarded DECIMAL(10,1) NOT NULL DEFAULT 0.0,
  time_spent_ms INT DEFAULT 0,
  UNIQUE KEY unique_answer (participant_id, question_id),
  CONSTRAINT fk_answers_participant FOREIGN KEY (participant_id) REFERENCES participants(id) ON DELETE CASCADE,
  CONSTRAINT fk_answers_question FOREIGN KEY (question_id) REFERENCES questions(id) ON DELETE CASCADE
);

-- Optional starter quiz can be created through the Admin interface.
