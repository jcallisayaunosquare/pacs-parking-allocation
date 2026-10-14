/**
 * Addresses no mail server will ever accept: the names RFC 2606 and RFC 6761 reserve
 * for documentation and testing.
 *
 * Inviting one of these costs a real email for nothing. With the pool on Cognito's
 * default sender that is the scarce resource - 50 messages a day for the whole account -
 * and every deploy's smoke test creates residents at `@example.test`. On 2026-10-14 those
 * invitations spent the day's quota by mid-morning, and a real resident created after
 * them got `LimitExceededException`: no Cognito user, no email, no way to sign in.
 */
const RESERVED_TLDS = ['test', 'example', 'invalid', 'localhost'];
const RESERVED_DOMAINS = ['example.com', 'example.net', 'example.org'];

export function isUndeliverable(email: string): boolean {
  const domain = email.slice(email.lastIndexOf('@') + 1).toLowerCase().replace(/\.$/, '');
  const tld = domain.slice(domain.lastIndexOf('.') + 1);
  return (
    RESERVED_TLDS.includes(tld) ||
    RESERVED_DOMAINS.some((d) => domain === d || domain.endsWith(`.${d}`))
  );
}
