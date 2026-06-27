function isUserExpired(expireDay) {
  if (expireDay == null || expireDay === '') return false;
  const exp = parseInt(expireDay, 10);
  if (Number.isNaN(exp)) return false;
  return exp < Math.floor(Date.now() / 1000);
}

module.exports = { isUserExpired };
