const express = require("express");
const axios = require("axios");

const app = express();

// =====================================================
// MIDDLEWARE
// =====================================================

app.use(express.json());

// =====================================================
// CẤU HÌNH SUPABASE
// =====================================================

const SUPABASE_URL =
  process.env.SUPABASE_URL ||
  "https://liwvtbsbemwktlyxwxsg.supabase.co";

const SUPABASE_SERVICE_KEY =
  process.env.SUPABASE_SERVICE_KEY;

const PORT = process.env.PORT || 3000;

// =====================================================
// HÀM TẠO HEADER SUPABASE
// =====================================================

function getSupabaseHeaders(extraHeaders = {}) {
  return {
    apikey: SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
    "Content-Type": "application/json",
    ...extraHeaders
  };
}

// =====================================================
// CHUẨN HÓA CHUỖI
// =====================================================

function normalizeText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/\s+/g, " ")
    .trim();
}

// =====================================================
// LẤY NỘI DUNG CHUYỂN KHOẢN
// =====================================================

function getPaymentContent(body) {
  return [
    body.code,
    body.content,
    body.description,
    body.transferContent,
    body.transfer_content
  ]
    .filter(
      value =>
        value !== null &&
        value !== undefined &&
        String(value).trim() !== ""
    )
    .map(value => String(value))
    .join(" ");
}

// =====================================================
// LẤY MÃ ĐƠN GDXXXXXX
// =====================================================

function extractOrderCode(paymentContent) {
  const normalizedContent =
    normalizeText(paymentContent);

  const match =
    normalizedContent.match(/\bGD\d+\b/i);

  if (!match) {
    return null;
  }

  return match[0].toUpperCase();
}

// =====================================================
// XÁC ĐỊNH LOẠI ĐƠN
// =====================================================

function determineOrderType(
  databaseOrderType,
  paymentContent
) {
  const currentOrderType =
    normalizeText(databaseOrderType);

  // Ưu tiên loại đơn đã lưu trong database
  if (
    currentOrderType === "SEND" ||
    currentOrderType === "RENT"
  ) {
    return currentOrderType;
  }

  const normalizedContent =
    normalizeText(paymentContent);

  // Gửi đồ
  if (
    normalizedContent.includes("GUI DO") ||
    normalizedContent.includes("GUI HANG") ||
    normalizedContent.includes("SEND")
  ) {
    return "SEND";
  }

  // Thuê tủ
  if (
    normalizedContent.includes("THUE TU") ||
    normalizedContent.includes("THUE NGAN TU") ||
    normalizedContent.includes("RENT")
  ) {
    return "RENT";
  }

  return null;
}

// =====================================================
// LẤY TRANSACTION ID
// =====================================================

function getTransactionId(body) {
  const value =
    body.id ||
    body.transaction_id ||
    body.transactionId ||
    body.referenceCode ||
    body.reference_code ||
    "";

  return String(value).trim();
}

// =====================================================
// LẤY SỐ TIỀN
// =====================================================

function getTransferAmount(body) {
  const value =
    body.transferAmount ??
    body.transfer_amount ??
    body.amount ??
    0;

  const amount = Number(value);

  return Number.isFinite(amount)
    ? amount
    : 0;
}

// =====================================================
// KIỂM TRA SERVER
// =====================================================

app.get("/", (req, res) => {
  return res.status(200).json({
    success: true,
    message:
      "Smart Locker Webhook Server is running"
  });
});

app.get("/health", (req, res) => {
  return res.status(200).json({
    success: true,
    server: "running",
    supabaseUrlConfigured:
      Boolean(SUPABASE_URL),
    supabaseKeyConfigured:
      Boolean(SUPABASE_SERVICE_KEY)
  });
});

// =====================================================
// WEBHOOK THANH TOÁN SEPAY
// =====================================================

app.post("/webhook/payment", async (req, res) => {
  try {
    console.log("");
    console.log(
      "========================================"
    );
    console.log("NHẬN WEBHOOK THANH TOÁN");
    console.log(
      JSON.stringify(req.body, null, 2)
    );
    console.log(
      "========================================"
    );

    // -------------------------------------------------
    // 1. KIỂM TRA CẤU HÌNH
    // -------------------------------------------------

    if (!SUPABASE_URL) {
      console.error(
        "Thiếu cấu hình SUPABASE_URL"
      );

      return res.status(500).json({
        success: false,
        message:
          "Server chưa cấu hình SUPABASE_URL"
      });
    }

    if (!SUPABASE_SERVICE_KEY) {
      console.error(
        "Thiếu SUPABASE_SERVICE_KEY"
      );

      return res.status(500).json({
        success: false,
        message:
          "Server chưa cấu hình SUPABASE_SERVICE_KEY"
      });
    }

    // -------------------------------------------------
    // 2. CHỈ NHẬN GIAO DỊCH TIỀN VÀO
    // -------------------------------------------------

    const transferType =
      normalizeText(
        req.body.transferType ||
        req.body.transfer_type
      ).toLowerCase();

    if (
      transferType &&
      transferType !== "in"
    ) {
      console.log(
        "Bỏ qua giao dịch không phải tiền vào:",
        transferType
      );

      return res.status(200).json({
        success: true,
        ignored: true,
        message:
          "Bỏ qua giao dịch không phải tiền vào"
      });
    }

    // -------------------------------------------------
    // 3. TÌM MÃ GDXXXXXX
    // -------------------------------------------------

    const paymentContent =
      getPaymentContent(req.body);

    const orderCode =
      extractOrderCode(paymentContent);

    console.log(
      "Nội dung chuyển khoản:",
      paymentContent
    );

    if (!orderCode) {
      console.warn(
        "Không tìm thấy mã GD trong nội dung"
      );

      /*
       * Trả 200 để SePay không gửi lại liên tục.
       * Giao dịch sai nội dung vẫn còn trong lịch sử
       * SePay để kiểm tra thủ công.
       */
      return res.status(200).json({
        success: true,
        ignored: true,
        message:
          "Không tìm thấy mã GD trong nội dung chuyển khoản"
      });
    }

    const transactionId =
      getTransactionId(req.body);

    const receivedAmount =
      getTransferAmount(req.body);

    console.log("Order code:", orderCode);
    console.log(
      "Transaction ID:",
      transactionId
    );
    console.log(
      "Số tiền nhận:",
      receivedAmount
    );

    // -------------------------------------------------
    // 4. TÌM ĐƠN TRONG PAYMENTS
    // -------------------------------------------------

    const findUrl =
      `${SUPABASE_URL}/rest/v1/payments` +
      `?order_code=eq.${encodeURIComponent(
        orderCode
      )}` +
      `&select=*`;

    const findResponse = await axios.get(
      findUrl,
      {
        headers: getSupabaseHeaders(),
        timeout: 15000
      }
    );

    const payments =
      Array.isArray(findResponse.data)
        ? findResponse.data
        : [];

    if (payments.length === 0) {
      console.warn(
        "Không tìm thấy đơn hàng:",
        orderCode
      );

      /*
       * Không trả 500 vì gửi lại cũng không thể
       * tìm thấy đơn nếu database chưa có đơn đó.
       */
      return res.status(200).json({
        success: true,
        ignored: true,
        message:
          "Không tìm thấy đơn thanh toán tương ứng",
        order_code: orderCode
      });
    }

    const payment = payments[0];

    console.log("Đơn hàng tìm được:");
    console.log(
      JSON.stringify(payment, null, 2)
    );

    // -------------------------------------------------
    // 5. CHỐNG XỬ LÝ TRÙNG GIAO DỊCH
    // -------------------------------------------------

    const currentPaymentStatus =
      normalizeText(
        payment.payment_status
      );

    const currentTransactionId =
      String(
        payment.transaction_id || ""
      ).trim();

    if (currentPaymentStatus === "PAID") {
      console.log(
        "Đơn đã được thanh toán trước đó:",
        orderCode
      );

      return res.status(200).json({
        success: true,
        duplicate: true,
        message:
          "Đơn đã được thanh toán trước đó",
        order_code: orderCode,
        transaction_id:
          currentTransactionId ||
          transactionId
      });
    }

    // -------------------------------------------------
    // 6. KIỂM TRA SỐ TIỀN
    // -------------------------------------------------

    const requiredAmount =
      Number(payment.amount || 0);

    if (
      requiredAmount > 0 &&
      receivedAmount > 0 &&
      receivedAmount < requiredAmount
    ) {
      console.warn(
        "Số tiền chuyển khoản không đủ:",
        {
          orderCode,
          requiredAmount,
          receivedAmount
        }
      );

      return res.status(200).json({
        success: true,
        ignored: true,
        message:
          "Số tiền chuyển khoản không đủ",
        order_code: orderCode,
        required_amount:
          requiredAmount,
        received_amount:
          receivedAmount
      });
    }

    // -------------------------------------------------
    // 7. XÁC ĐỊNH ORDER_TYPE
    // -------------------------------------------------

    const finalOrderType =
      determineOrderType(
        payment.order_type,
        paymentContent
      );

    console.log(
      "Order type trong database:",
      payment.order_type
    );

    console.log(
      "Order type cuối cùng:",
      finalOrderType
    );

    if (!finalOrderType) {
      console.error(
        "Không xác định được order_type",
        {
          orderCode,
          databaseOrderType:
            payment.order_type,
          paymentContent
        }
      );

      /*
       * Trả 200 để tránh retry vô hạn.
       * Không cập nhật PAID vì chưa biết đây là
       * SEND hay RENT.
       */
      return res.status(200).json({
        success: true,
        ignored: true,
        message:
          "Không xác định được loại đơn SEND hoặc RENT",
        order_code: orderCode
      });
    }

    // -------------------------------------------------
    // 8. CẬP NHẬT ORDER_TYPE VÀ PAID CÙNG LÚC
    // -------------------------------------------------
    /*
     * Khi PATCH cùng lúc:
     *
     * order_type = SEND/RENT
     * payment_status = PAID
     *
     * Trigger Supabase sẽ nhận NEW.order_type hợp lệ,
     * nên không còn lỗi INVALID_ORDER_TYPE.
     */

    const updateData = {
      order_type: finalOrderType,
      payment_status: "PAID",
      transaction_id:
        transactionId ||
        currentTransactionId ||
        null
    };

    const updateUrl =
      `${SUPABASE_URL}/rest/v1/payments` +
      `?order_code=eq.${encodeURIComponent(
        orderCode
      )}`;

    const updateResponse =
      await axios.patch(
        updateUrl,
        updateData,
        {
          headers: getSupabaseHeaders({
            Prefer:
              "return=representation"
          }),
          timeout: 15000
        }
      );

    const updatedPayments =
      Array.isArray(updateResponse.data)
        ? updateResponse.data
        : [];

    if (updatedPayments.length === 0) {
      console.error(
        "PATCH không cập nhật được bản ghi nào"
      );

      return res.status(500).json({
        success: false,
        message:
          "Không cập nhật được đơn thanh toán",
        order_code: orderCode
      });
    }

    const updatedPayment =
      updatedPayments[0];

    console.log(
      "CẬP NHẬT THANH TOÁN THÀNH CÔNG"
    );

    console.log(
      JSON.stringify(
        updatedPayment,
        null,
        2
      )
    );

    return res.status(200).json({
      success: true,
      message:
        "Thanh toán đã được xử lý thành công",
      order_code: orderCode,
      order_type: finalOrderType,
      transaction_id:
        transactionId,
      payment_status:
        updatedPayment.payment_status,
      fulfillment_status:
        updatedPayment.fulfillment_status,
      locker_id:
        updatedPayment.locker_id,
      locker_number:
        updatedPayment.locker_number,
      pickup_code:
        updatedPayment.pickup_code
    });
  } catch (error) {
    console.error("");
    console.error(
      "========================================"
    );
    console.error("LỖI XỬ LÝ WEBHOOK");
    console.error(
      "Message:",
      error.message
    );
    console.error(
      "Status:",
      error.response?.status
    );
    console.error(
      "Response:",
      error.response?.data
    );
    console.error(
      "URL:",
      error.config?.url
    );
    console.error(
      "Request data:",
      error.config?.data
    );
    console.error(
      "========================================"
    );

    return res.status(500).json({
      success: false,
      error: error.message,
      downstream_status:
        error.response?.status || null,
      downstream_response:
        error.response?.data || null
    });
  }
});

// =====================================================
// ROUTE KHÔNG TỒN TẠI
// =====================================================

app.use((req, res) => {
  return res.status(404).json({
    success: false,
    message:
      "Endpoint không tồn tại"
  });
});

// =====================================================
// KHỞI ĐỘNG SERVER
// =====================================================

app.listen(PORT, () => {
  console.log(
    `Server running on port ${PORT}`
  );

  console.log(
    `SUPABASE_URL configured: ${Boolean(
      SUPABASE_URL
    )}`
  );

  console.log(
    `SUPABASE_SERVICE_KEY configured: ${Boolean(
      SUPABASE_SERVICE_KEY
    )}`
  );
});