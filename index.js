const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

const SUPABASE_URL = "https://liwvtbsbemwktlyxwxsg.supabase.co";
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

app.get("/", (req, res) => {
  res.send("Smart Locker Webhook Server is running");
});

app.post("/webhook/payment", async (req, res) => {
  try {
    console.log("Webhook body:", req.body);

    const description = String(
      req.body.description ||
      req.body.content ||
      req.body.transferContent ||
      ""
    );

    const match = description.match(/GD\d+/);

    if (!match) {
      return res.status(200).json({ message: "No order code found" });
    }

    const orderCode = match[0];

    await axios.patch(
      `${SUPABASE_URL}/rest/v1/payments?order_code=eq.${orderCode}`,
      {
        payment_status: "PAID",
        transaction_id: String(req.body.transaction_id || req.body.id || Date.now()),
        paid_at: new Date().toISOString()
      },
      {
        headers: {
          apikey: SUPABASE_SERVICE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
          "Content-Type": "application/json"
        }
      }
    );

    res.status(200).json({
      message: "Payment updated",
      order_code: orderCode
    });

  } catch (error) {
    console.error("Webhook error:", error.message);
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});