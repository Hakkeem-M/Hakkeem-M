import jwt from 'jsonwebtoken';
import { HttpError } from './util.js';

export const STAFF = ['ADMIN', 'OPS', 'FINANCE', 'SALES', 'WAREHOUSE'];

export function signToken(user, config) {
  return jwt.sign(
    { sub: String(user.id), role: user.role, tv: user.token_version ?? 0 },
    config.jwtSecret,
    { expiresIn: config.jwtTtl, issuer: 'abc-cargo', audience: 'abc-cargo-apps' },
  );
}

/** Verifies bearer token and re-loads the user so deactivation / role changes take effect immediately. */
export function requireAuth(req, _res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return next(new HttpError(401, 'Authentication required'));
  let payload;
  try {
    payload = jwt.verify(token, req.config.jwtSecret, { issuer: 'abc-cargo', audience: 'abc-cargo-apps' });
  } catch {
    return next(new HttpError(401, 'Session expired or invalid'));
  }
  const user = req.db.get(
    'SELECT id, name, email, phone, role, customer_id, branch_id, vehicle_no, active, token_version FROM users WHERE id = ?',
    Number(payload.sub),
  );
  if (!user || !user.active || user.token_version !== payload.tv) {
    return next(new HttpError(401, 'Session no longer valid'));
  }
  req.user = user;
  next();
}

export const requireRole = (...roles) => (req, _res, next) => {
  if (!req.user) return next(new HttpError(401, 'Authentication required'));
  if (!roles.includes(req.user.role)) return next(new HttpError(403, 'You do not have permission for this action'));
  next();
};

export const publicUser = (u) => ({
  id: u.id, name: u.name, email: u.email, phone: u.phone, role: u.role,
  customer_id: u.customer_id, branch_id: u.branch_id, vehicle_no: u.vehicle_no,
});
