-- The operator role is gone; user administrators (user_admin) sit between
-- user and admin. Former operators fall back to plain users: their
-- infrastructure duties now belong to admins, and user administration is a
-- new power an admin must grant explicitly.
ALTER TABLE iam.users DROP CONSTRAINT users_role_check;

UPDATE iam.users SET role = 'user', updated_at = clock_timestamp() WHERE role = 'operator';

ALTER TABLE iam.users
    ADD CONSTRAINT users_role_check CHECK (role = ANY (ARRAY['user', 'user_admin', 'admin']));

COMMENT ON COLUMN iam.users.role IS
  'Platform role (user < user_admin < admin); read on every request, so a change is immediate';
