import { paymentMiddleware } from "x402-next";

export const proxy = paymentMiddleware(
  process.env.PAYMENT_ADDRESS as `0x${string}`,
  {
    "/journal/:path*": {
      price: "$0.001",
      network: "base",
      config: {
        description: "Sebastian D. Hunter — Hourly Journal Entry",
      },
    },
    "/day/:path*": {
      price: "$0.001",
      network: "base",
      config: {
        description: "Sebastian D. Hunter — Daily Belief Report",
      },
    },
  }
);

export const config = {
  matcher: ["/journal/:path*", "/day/:path*"],
};
