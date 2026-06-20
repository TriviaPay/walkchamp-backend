import type { NextFunction, Request, Response } from "express";
import multer from "multer";

function requestIdOf(req: Request): string | null {
  return (req as Request & { id?: string }).id ?? null;
}

export function notFoundHandler(req: Request, res: Response) {
  res.status(404).json({
    error: "Route not found",
    code: "ROUTE_NOT_FOUND",
    requestId: requestIdOf(req),
  });
}

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  const requestId = requestIdOf(req);

  if (res.headersSent) {
    return;
  }

  if (err instanceof multer.MulterError) {
    return res.status(400).json({
      error: err.message,
      code: "UPLOAD_ERROR",
      requestId,
    });
  }

  if (err instanceof Error && /request entity too large/i.test(err.message)) {
    return res.status(413).json({
      error: "Request payload is too large.",
      code: "PAYLOAD_TOO_LARGE",
      requestId,
    });
  }

  if (err instanceof Error && /cors/i.test(err.message)) {
    return res.status(403).json({
      error: "Origin is not allowed.",
      code: "CORS_DENIED",
      requestId,
    });
  }

  req.log.error({ err, requestId }, "Unhandled request error");
  return res.status(500).json({
    error: "Internal server error",
    code: "INTERNAL_SERVER_ERROR",
    requestId,
  });
}
