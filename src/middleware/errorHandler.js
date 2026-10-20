import multer from 'multer';

/**
 * 404 Not Found handler
 */
export function notFoundHandler(req, res, next) {
  res.status(404).json({
    success: false,
    error: `Endpoint not found: ${req.method} ${req.originalUrl}`
  });
}

/**
 * Central Express error handler
 */
export function errorHandler(err, req, res, next) {
  console.error('[TorrentFlow Server Error]:', err.message || err);

  // Handle Multer upload errors
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({
        success: false,
        error: 'Uploaded file exceeds the maximum allowed file size limit.'
      });
    }
    return res.status(400).json({
      success: false,
      error: `File upload error: ${err.message}`
    });
  }

  // Handle SyntaxError (e.g., malformed JSON in request body)
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    return res.status(400).json({
      success: false,
      error: 'Malformed JSON payload in request body.'
    });
  }

  const statusCode = err.statusCode || err.status || 500;
  const response = {
    success: false,
    error: err.message || 'Internal server error occurred.'
  };

  // Provide details only in non-production environments
  if (process.env.NODE_ENV !== 'production' && err.stack) {
    response.stack = err.stack;
  }

  res.status(statusCode).json(response);
}

export default errorHandler;

