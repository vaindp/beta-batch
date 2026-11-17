# Beta Batch — bản web biên tập truyện

## Bối cảnh tác phẩm

Trong tab **Quy tắc → Bối cảnh tác phẩm**, chọn **Hiện đại**, **Cổ đại** hoặc **Tương lai (viễn tưởng)**. Bối cảnh được lưu cùng truyện trong trình duyệt và áp dụng cho cả biên tập thường lẫn Batch. Khi chưa chọn, ứng dụng giữ cách xử lý theo nguyên tác như trước.

Bối cảnh hướng dẫn chọn từ và sửa câu phù hợp thời đại, không cho phép đổi ý gốc, tên riêng, chức danh hoặc tự thêm tình tiết. Quy tắc đại từ và bảng xưng hô cụ thể vẫn được ưu tiên. Đổi bối cảnh sẽ dùng tiền tố prompt/cache mới. Batch lưu bối cảnh tại lúc gửi; nếu bạn đổi bối cảnh trong khi chờ, kết quả cũ được đánh dấu xung đột để tránh nhập vào truyện theo quy tắc khác. Job và dự án cũ chưa có bối cảnh vẫn đọc được.

## Xóa lịch sử Batch

Cả thanh bên và cửa sổ mở rộng đều có **Xóa lịch sử job đang chọn** và **Xóa các job đã kết thúc**, kèm bước xác nhận hoặc **Giữ lại**. Xóa chỉ loại bản ghi job/kết quả khỏi bộ nhớ trình duyệt, không xóa chương đã nhập, không hủy job và không xóa file trên Google Cloud. Tải **Sao lưu job** trước nếu cần khôi phục sau này.

Chỉ xóa được job đã kết thúc (thành công, lỗi, hủy, hết hạn, hoàn tất một phần), hoặc bản chuẩn bị chưa gửi. Job đang chờ/chạy/đang gửi hay chưa xác định trạng thái cần cập nhật, tìm lại hoặc hủy và chờ kết thúc trước. Xóa nhiều bản ghi là một giao dịch: nếu có job vừa chuyển sang đang chạy ở tab khác, toàn bộ lần xóa được giữ lại. Hai giao diện cập nhật cùng nhau, tự chọn job còn lại hoặc hiển thị lịch sử trống.

Bản web riêng, kế thừa giao diện và bộ quy tắc biên tập của Beta. Mỗi chương là một yêu cầu độc lập trong cùng Batch job. Trong **Batch API → Model cho job mới**, chọn model từ cùng danh sách với biên tập thường. Không cần nhập Model ID thủ công; danh sách dùng chung nằm trong `src/ai/models.ts`. Model cần hỗ trợ Vertex AI Batch tại `global` và project phải có quyền sử dụng. Không cần văn bản mẫu; không gộp nhiều chương vào một câu trả lời.

Hai giao diện Batch dùng chung cấu hình bucket/model/thinking, chương đã chọn, job hiện tại, kết quả, thông báo, khóa thao tác, bộ đếm và một luồng kiểm tra trạng thái. Lựa chọn model Batch được nhớ trong trình duyệt, độc lập với model biên tập trực tiếp trong Cài đặt. Mỗi job lưu model riêng trong lịch sử và bản sao; đổi lựa chọn không thay đổi job đã gửi. Job cũ chưa có trường model vẫn được nhận diện là `gemini-4-argon`. Với Argon, thinking mặc định **MEDIUM**, có LOW và HIGH để chọn. Các model khác dùng thinking và giới hạn đầu ra mặc định của model, không gửi cấu hình riêng của Argon.

Đây là website tĩnh, dùng được trên **GitHub Pages** và các dịch vụ static hosting. Không cần máy chủ Node khi sử dụng, không có bản cài đặt desktop. Trình duyệt gọi trực tiếp Google OAuth, Vertex AI và Cloud Storage.

## Chạy và cập nhật Vercel

Dự án dùng Node.js 22 và `bun.lock`. Cài thư viện bằng `bun install --frozen-lockfile`, sau đó chạy:

```sh
npm test
npm run lint
npm run build
npm run dev
```

Nếu dùng npm để cài thư viện, repo hiện có xung đột peer dependency giữa Vite và esbuild; dùng `npm install --legacy-peer-deps`.

Website dùng `index.html` → `src/main.tsx` → `src/App.tsx`. Các tệp cần sửa nằm trong `src/`; không dùng các bản tham khảo trong `public/assets/aistudio/` hoặc `index.tsx` ở thư mục gốc.

Để cập nhật bản Vercel hiện có, ghi đè các tệp trong gói cập nhật vào đúng đường dẫn tại thư mục gốc repo, bao gồm tệp mới và `bun.lock`, rồi commit lên nhánh đang được Vercel theo dõi. Build command: `npm run build`; output directory: `dist`. Đợi deployment thành công rồi tải lại trang.

Không đưa `node_modules`, `.env`, khóa Service Account JSON, dữ liệu truyện hoặc bản sao job lên repository.

## Thiết lập Google Cloud một lần

Batch ở bản này dùng **Vertex AI / Gemini Enterprise Agent Platform**. API key của Gemini Developer API không thay thế được file Service Account JSON trong luồng này.

1. Chọn project có billing và đã bật Vertex AI API (`aiplatform.googleapis.com`), có quyền dùng model đã chọn.
2. Trong [Google Cloud Console → Cloud Storage → Buckets](https://console.cloud.google.com/storage/browser), chọn **Create** nếu chưa có bucket. Dùng tên duy nhất, Standard storage, vùng phù hợp dữ liệu của bạn; giữ Uniform bucket-level access và Public access prevention. Không cần bật public.
3. Tài khoản trong file JSON cần quyền tạo/đọc/hủy/list Batch job. Vai trò thông dụng là **Vertex AI User** (`roles/aiplatform.user`) trên project chạy job.
4. Trên bucket đầu vào/đầu ra, cấp **Storage Object User** (`roles/storage.objectUser`) cho email tài khoản trong file JSON để upload, liệt kê và tải file.
5. Service Agent của Vertex AI cũng phải đọc/ghi được bucket. Đặc biệt khi dùng bucket khác project, cấp quyền đối tượng phù hợp cho `service-PROJECT_NUMBER@gcp-sa-aiplatform.iam.gserviceaccount.com` của project chạy job. Không nhầm email này với service account trong file JSON.
6. Nhập tên bucket vào web, ví dụ `ten-bucket` hoặc `gs://ten-bucket`. Không nhập đường dẫn con.

Web dùng Cloud Storage **JSON API** nên không cần sửa bucket thành public hoặc mở CORS thủ công. [Tài liệu CORS của Google](https://docs.cloud.google.com/storage/docs/cross-origin) giải thích JSON API xử lý CORS riêng.

Quyền `storage.buckets.list` không bắt buộc khi đã biết tên bucket. Nếu không xem được danh sách bucket, hãy dùng tài khoản chủ project trong Console; điều đó chưa chứng minh tài khoản thiếu quyền đối tượng trên một bucket cụ thể.

## Cách biên tập

1. Tải `.txt` có tiêu đề `Chương 1…`, `Chương 2…` vào màn hình chính. Điền quy tắc đại từ/xưng hô như bản Beta.
2. Mở **Cài đặt**, chọn kết nối bằng file JSON và nạp khóa từ máy. Khóa được giữ trong `sessionStorage` của tab, không nằm trong bản build hay bản sao job. Mở phiên mới cần nạp lại. Chỉ nạp khóa vào bản web bạn tin cậy và kiểm soát.
3. Mở **Batch API**, nhập bucket, chọn model và các chương cần biên tập. Chương đã hoàn tất chỉ gửi lại nếu bạn tự chọn; mỗi lượt gửi lại vẫn có phí.
4. Bấm **Gửi Batch**. Web lưu bản chụp chương/quy tắc vào IndexedDB, upload JSONL rồi tạo job ở vùng `global`. File đầu vào nằm dưới `beta-batch/<mã-job>/input.jsonl`, kết quả dưới `beta-batch/<mã-job>/output/`.
5. Tải **Sao lưu job** để giữ bản đối chiếu chương. Bản sao chứa nội dung truyện và prompt, không chứa khóa. Giữ riêng tư.
6. Có thể đóng web. Google vẫn xử lý. Mở lại cùng địa chỉ web và trình duyệt, nạp khóa nếu cần, chọn job; trạng thái job đang chọn cập nhật mỗi 30 giây.
7. Khi job kết thúc, bấm **Lấy kết quả từ Google**. Các job thất bại/hủy một phần vẫn có thể có chương đã xử lý. Kiểm tra từng dòng rồi bấm **Nhập các chương hợp lệ**.
8. Bản biên tập về màn hình chính với đánh dấu thay đổi. Có thể sửa và xuất TXT/DOCX bằng chức năng có sẵn.

Không trộn nút biên tập trực tiếp từng chương với Batch nếu không muốn gửi thêm yêu cầu Standard có phí. Chi phí Standard có sẵn trong giao diện không được áp dụng cho kết quả Batch; Batch hiển thị số token Google trả, chi phí thực xem trong Cloud Billing.

## Những trường hợp đã xử lý

- Kết quả có thể đảo thứ tự: đối chiếu SHA-256 của văn bản request được Google trả lại, không lấy số dòng làm số chương. Mỗi request có mã cuối prompt để phân biệt cả hai chương có văn bản giống hệt nhau.
- Giữ nguyên phần quy tắc chung ở đầu request. Không tạo Explicit Cache, không hứa chắc có Implicit Cache hit.
- Không nhập phần `thought`, không coi kết quả rỗng, lỗi hoặc `MAX_TOKENS` là chương hoàn tất.
- Bản gốc, bản sửa, tiêu đề hoặc quy tắc đã thay đổi trong khi chờ: giữ nguyên nội dung hiện tại, cho xem/tải kết quả riêng. Nhập lại cùng một job không ghi đè lần thứ hai.
- Chặn hai tab cùng gửi chương đang có job chạy. Không tự thử lại POST tạo job khi chưa rõ Google đã nhận hay chưa.
- Nếu mạng ngắt sau khi gửi, dùng **Tìm job đã gửi**, hoặc dán tên tài nguyên job từ Console. Không gửi lại chỉ vì chưa thấy kết quả ngay.
- Nếu đọc Cloud Storage lỗi, tải tất cả file kết quả `.jsonl` bằng Console rồi dùng **Nhập file kết quả JSONL**. Web sẽ báo dòng lỗi, không khớp hoặc thiếu.
- Lịch sử job nằm trong IndexedDB; dự án biên tập nằm trong localStorage. Đổi trình duyệt/địa chỉ website hoặc xóa dữ liệu trang sẽ không tự mang theo dự án. Bản sao job khôi phục việc theo dõi và tải kết quả; việc nhập tự động vẫn cần dự án có đúng ID và nội dung chương tại thời điểm gửi. Nếu mất dự án, dùng tải TXT các kết quả hợp lệ để lấy lại văn bản.
- Web không tự xóa dữ liệu trên bucket. Bạn có thể xóa thư mục job đã dùng xong hoặc đặt lifecycle bằng Console. Cloud Storage có phí lưu trữ/thao tác và có thể có phí truyền dữ liệu.

## Kiểm chứng và giới hạn

`npm test` kiểm tra cấu trúc request, kết quả đảo thứ tự, văn bản giống nhau, lỗi một phần, token đầu ra bị cắt, bản sửa tay, nhập lặp, upload/tạo/đọc/hủy job, phân trang file và lỗi mạng. Các bài kiểm tra API dùng mock, không gọi model hoặc phát sinh phí.

Job thật còn phụ thuộc quyền IAM, bucket và quyền model của project. Batch không đảm bảo phản hồi ngay. Theo [tài liệu Batch của Google](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/capabilities/batch-inference), Batch có mức giá thấp hơn xử lý trực tiếp và Argon nằm trong danh sách hỗ trợ; nên kiểm tra bảng giá tại thời điểm dùng. Không coi cache là điều kiện để Batch hoạt động.

Tham khảo giao thức: [Batch từ Cloud Storage](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/capabilities/batch-inference/new-job-from-cloud-storage), [hướng dẫn Argon và thinking](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/guides/gemini-4-argon).

## Bản sửa Batch ngày 18/11/2026

- Website chạy `src/main.tsx` → `src/App.tsx`; cập nhật đúng các tệp trong `src/`.
- Không gửi `generationConfig: {}`. Với model dùng cấu hình mặc định, bỏ hẳn trường này khỏi JSONL. Xuất JSONL từ bản sao cũ cũng loại cấu trúc rỗng.
- Các job đã bị Google từ chối nhập dữ liệu không tự chạy lại sau khi cập nhật web. Chọn lại chương và gửi một job mới bằng bản đã sửa; không gửi lại job đang chờ/đang chạy.
- Chạy `npm test`, `npm run lint`, `npm run build`. Kiểm thử dùng API giả lập, không tạo job tính phí.
