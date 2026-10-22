// Kiểu cho res.locals dùng chung giữa middleware và controller.
declare global {
  namespace Express {
    interface Locals {
      body?: unknown;
      auth?: { userId: string; sessionId: string; exp: number };
    }
  }
}

export {};
