const express = require("express");
const axios = require("axios");

const app = express();

app.use(express.json());

// =====================================================
// CẤU HÌNH SUPABASE
// =====================================================

const SUPABASE_URL = "https://liwvtbsbemwktlyxwxsg.supabase.co";
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

// =====================================================
// TRANG KIỂM TRA SERVER
// =====================================================

app.get("/", (req, res) => {
  return res.status(200).json({
    success: true,
    message: "Smart Locker Webhook Server is running"
  });
});

// =====================================================
// KIỂM TRA BIẾN MÔI TRƯỜNG
// =====================================================

app.get("/health", (req, res) => {
  return res.status(200).json({
    success: true,
    server: "running",
    supabaseUrlConfigured: Boolean(SUPABASE_URL),
    supabaseKeyConfigured: Boolean(SUPABASE_SERVICE_KEY)
  });
});

// =====================================================
// WEBHOOK NHẬN THANH TOÁN TỪ SEPAY
// =====================================================

app.post("/webhook/payment", async (req, res) => {
  try {
    console.log("========================================");
    console.log("NHẬN WEBHOOK TỪ SEPAY");
    console.log(JSON.stringify(req.body, null, 2));
    console.log("========================================");

    // -------------------------------------------------
    // 1. Kiểm tra khóa Supabase
    // -------------------------------------------------

    if (!SUPABASE_SERVICE_KEY) {
      console.error("Thiếu biến môi trường SUPABASE_SERVICE_KEY");

      return res.status(500).json({
        success: false,
        message: "Server chưa cấu hình SUPABASE_SERVICE_KEY"
      });
    }

    // -------------------------------------------------
    // 2. Chỉ xử lý giao dịch tiền vào
    // -------------------------------------------------

    const transferType = String(
      req.body.transferType ||
      req.body.transfer_type ||
      ""
    ).toLowerCase();

    if (transferType && transferType !== "in") {
      console.log("Bỏ qua giao dịch tiền ra:", transferType);

      // Trả 200 để SePay không gửi lại
      return res.status(200).json({
        success: true,
        ignored: true,
        message: "Giao dịch không phải tiền vào"
      });
    }

    // -------------------------------------------------
    // 3. Ghép các trường có thể chứa mã đơn
    // -------------------------------------------------

    const paymentContent = [
      req.body.code,
      req.body.content,
      req.body.description,
      req.body.transferContent,
      req.body.transfer_content
    ]
      .filter(value => value !== null && value !== undefined)
      .map(value => String(value))
      .join(" ")
      .toUpperCase();

    console.log("Nội dung thanh toán:", paymentContent);

    // Tìm mã dạng GD123456
    const match = paymentContent.match(/\bGD\d+\b/i);

    if (!match) {
      console.log("Không tìm thấy mã GD trong nội dung chuyển khoản");

      // Không nên trả 500 vì SePay sẽ gửi lại liên tục
      return res.status(200).json({
        success: true,
        ignored: true,
        message: "Không tìm thấy mã đơn trong nội dung chuyển khoản"
      });
    }

    const orderCode = match[0].toUpperCase();

    console.log("Mã đơn tìm được:", orderCode);

    // -------------------------------------------------
    // 4. Lấy mã giao dịch SePay
    // -------------------------------------------------

    const transactionId = String(
      req.body.id ||
      req.body.transaction_id ||
      req.body.transactionId ||
      req.body.referenceCode ||
      ""
    );

    const transferAmount = Number(
      req.body.transferAmount ||
      req.body.transfer_amount ||
      0
    );

    // -------------------------------------------------
    // 5. Tìm đơn hàng trong Supabase trước
    // -------------------------------------------------

    const findUrl =
      `${SUPABASE_URL}/rest/v1/payments` +
      `?order_code=eq.${encodeURIComponent(orderCode)}` +
      `&select=id,order_code,payment_status,transaction_id,amount,locker_id`;

    const findResponse = await axios.get(findUrl, {
      headers: {
        apikey: SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
        "Content-Type": "application/json"
      },
      timeout: 15000
    });

    const payments = Array.isArray(findResponse.data)
      ? findResponse.data
      : [];

    if (payments.length === 0) {
      console.log("Không tìm thấy đơn hàng:", orderCode);

      /*
       * Trả 200 để SePay ngừng gửi lại.
       * Giao dịch vẫn được ghi trong lịch sử SePay để kiểm tra thủ công.
       */
      return res.status(200).json({
        success: true,
        ignored: true,
        message: "Không tìm thấy đơn hàng tương ứng",
        order_code: orderCode
      });
    }

    const payment = payments[0];

    console.log("Đơn hàng tìm được:", payment);

    // -------------------------------------------------
    // 6. Chống xử lý lại cùng một giao dịch
    // -------------------------------------------------

    if (
      String(payment.payment_status || "").toUpperCase() === "PAID" &&
      String(payment.transaction_id || "") === transactionId
    ) {
      console.log("Giao dịch đã được xử lý trước đó:", transactionId);

      return res.status(200).json({
        success: true,
        duplicate: true,
        message: "Giao dịch đã được xử lý trước đó",
        order_code: orderCode,
        transaction_id: transactionId
      });
    }

    // -------------------------------------------------
    // 7. Kiểm tra số tiền
    // -------------------------------------------------

    const requiredAmount = Number(payment.amount || 0);

    if (
      requiredAmount > 0 &&
      transferAmount > 0 &&
      transferAmount < requiredAmount
    ) {
      console.log("Số tiền chuyển không đủ:", {
        requiredAmount,
        transferAmount
      });

      return res.status(200).json({
        success: true,
        ignored: true,
        message: "Số tiền thanh toán không đủ",
        order_code: orderCode,
        required_amount: requiredAmount,
        received_amount: transferAmount
      });
    }

    // -------------------------------------------------
    // 8. Cập nhật đơn thanh toán
    // -------------------------------------------------
    // Không gửi paid_at vì bảng hiện tại có thể không có cột này.

    const updateData = {
      payment_status: "PAID",
      transaction_id: transactionId
    };

    const updateUrl =
      `${SUPABASE_URL}/rest/v1/payments` +
      `?order_code=eq.${encodeURIComponent(orderCode)}`;

    const updateResponse = await axios.patch(
      updateUrl,
      updateData,
      {
        headers: {
          apikey: SUPABASE_SERVICE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
          "Content-Type": "application/json",
          Prefer: "return=representation"
        },
        timeout: 15000
      }
    );

    console.log("Cập nhật thanh toán thành công:");
    console.log(JSON.stringify(updateResponse.data, null, 2));

    return res.status(200).json({
      success: true,
      message: "Payment updated successfully",
      order_code: orderCode,
      transaction_id: transactionId
    });

  } catch (error) {
    console.error("========================================");
    console.error("LỖI XỬ LÝ WEBHOOK");
    console.error("Message:", error.message);
    console.error("Status:", error.response?.status);
    console.error("Response:", error.response?.data);
    console.error("URL:", error.config?.url);
    console.error("Request data:", error.config?.data);
    console.error("========================================");

    return res.status(500).json({
      success: false,
      error: error.message,
      supabase_status: error.response?.status || null,
      supabase_response: error.response?.data || null
    });
  }
});

// =====================================================
// XỬ LÝ ROUTE KHÔNG TỒN TẠI
// =====================================================

app.use((req, res) => {
  return res.status(404).json({
    success: false,
    message: "Endpoint không tồn tại"
  });
});

// =====================================================
// KHỞI ĐỘNG SERVER
// =====================================================

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(
    `SUPABASE_SERVICE_KEY configured: ${Boolean(SUPABASE_SERVICE_KEY)}`
  );
});