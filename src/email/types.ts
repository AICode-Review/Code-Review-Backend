export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export interface EmailSendResult {
  sent: boolean;
  error?: string;
}
