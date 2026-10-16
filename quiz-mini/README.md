# Quiz Mini — HTML/CSS/JavaScript + Node.js + MySQL

Website quiz mini có 2 actor:
- **Admin**: đăng nhập, tạo quiz và câu hỏi, xem danh sách người tham dự (họ tên + SBD), xem bảng xếp hạng (chỉ hiện tên và điểm), mở/khóa/kết thúc quiz.
- **AnyPeople**: nhập họ tên + SBD, vào phòng chờ, trình duyệt tự kiểm tra trạng thái mỗi 2,5 giây và hiển thị câu hỏi khi admin mở bài, nộp bài và xem điểm.

Giao diện responsive cho desktop, tablet và điện thoại. Đây là website web responsive; backend API có thể dùng tiếp cho ứng dụng mobile riêng.

## 1. Yêu cầu
- Node.js 18+
- MySQL 8+ (hoặc MySQL tương thích)
- npm

## 2. Cài đặt
1. Tạo database và bảng:
   ```bash
   mysql -u root -p < schema.sql
   ```
2. Tạo file `.env` từ `.env.example`, điền thông tin MySQL và **đổi mật khẩu admin**.
3. Cài thư viện và chạy:
   ```bash
   npm install
   npm start
   ```
4. Mở `http://localhost:3000`.

## 3. Tài khoản admin
Mặc định trong `.env.example` là `admin / ChangeMe123!`. Chỉ dùng để chạy thử local. Hãy đổi `ADMIN_PASSWORD` và `SESSION_SECRET` trong `.env` trước khi deploy.

## 4. Cách sử dụng
1. Mở tab **Quản trị**, đăng nhập admin.
2. Tạo quiz, thêm ít nhất một câu hỏi, nhập đủ 4 lựa chọn và chọn đáp án đúng.
3. Quiz mới mặc định **đang khóa**.
4. Người chơi mở tab **Tham gia**, nhập họ tên + SBD rồi bấm tham gia. Trang sẽ chuyển sang phòng chờ.
5. Admin bấm **Mở quiz**. Người chơi đang chờ sẽ tự thấy bài làm.
6. Người chơi nộp bài. Admin chọn **Xem dữ liệu** để xem danh sách và xếp hạng.
7. Admin có thể **Khóa quiz** hoặc **Kết thúc** quiz.

## 5. Cấu trúc repository
```text
quiz-mini/
├── public/
│   ├── index.html
│   ├── styles.css
│   └── app.js
├── src/
│   ├── config/db.js
│   ├── middleware/requireAdmin.js
│   ├── repositories/quizRepository.js
│   └── routes/
│       ├── authRoutes.js
│       └── quizRoutes.js
├── schema.sql
├── server.js
├── package.json
└── .env.example
```

## 6. API cho mobile hoặc frontend khác
Các API trả JSON, có thể dùng làm backend cho Android/iOS. Admin endpoints dùng session cookie hiện tại; với ứng dụng mobile production nên thay bằng JWT hoặc token-based auth.

| Method | Endpoint | Mục đích |
|---|---|---|
| POST | `/api/auth/admin-login` | Đăng nhập admin |
| GET | `/api/public/state` | Trạng thái quiz mới nhất |
| POST | `/api/public/join` | Đăng ký tham gia |
| GET | `/api/public/participant/:id/state` | Trạng thái chờ / câu hỏi / kết quả |
| POST | `/api/public/participant/:id/submit` | Nộp đáp án |
| GET | `/api/admin/quizzes` | Danh sách quiz (admin) |
| POST | `/api/admin/quizzes` | Tạo quiz (admin) |
| POST | `/api/admin/quizzes/:id/status` | Mở / khóa / kết thúc |
| GET | `/api/admin/quizzes/:id/participants` | Danh sách họ tên + SBD |
| GET | `/api/admin/quizzes/:id/ranking` | Xếp hạng |

## 7. Lưu ý kỹ thuật trước khi deploy
- Không mở cổng MySQL ra internet công khai; chỉ cho backend kết nối.
- Dùng HTTPS, mật khẩu mạnh và `SESSION_SECRET` ngẫu nhiên.
- Thêm rate limit, CSRF protection, kiểm tra dữ liệu và cơ chế khôi phục mật khẩu nếu dùng thật.
- Bản demo dùng session cookie cho admin. Với nhiều máy chủ backend, cần session store dùng chung (Redis/database), không dùng MemoryStore mặc định.
- Hiện tại mỗi quiz có SBD duy nhất. Người chơi không thể tham gia quiz hai lần với cùng SBD.
- Khóa quiz ngăn nộp bài mới qua API, nhưng nên định nghĩa rõ quy tắc cho người đang làm dở trước khi dùng thi chính thức.
