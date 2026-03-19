import Twilio from "twilio";

const client = Twilio(process.env.TWILIO_ACCOUNT_SID!, process.env.TWILIO_AUTH_TOKEN!);
const from = `whatsapp:${process.env.TWILIO_WHATSAPP_FROM}`;

export async function sendWhatsApp(to: string, body: string) {
  const phone = to.replace(/\s/g, "");
  return client.messages.create({ from, to: `whatsapp:${phone}`, body });
}
