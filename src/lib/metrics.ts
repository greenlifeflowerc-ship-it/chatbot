// Tiny in-process counters for live diagnosis. Reset on restart — persistent
// delivery history lives in the webhook_events table; this only distinguishes
// "Meta isn't sending" from "arriving but signature-rejected" since boot.
export const metrics = {
  webhookSignatureFailures: 0,
};
