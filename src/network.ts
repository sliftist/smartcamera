/**
 * Who is allowed to reach this at all, before any password is considered.
 *
 * The service binds every interface so it can be read from a phone, which means a port forward or a
 * misconfigured router is all that stands between it and the internet. This is the backstop: a
 * connection from outside the local network is refused whatever password it offers, so forwarding the
 * port by accident exposes nothing. The password is for people on the network; this is for everyone
 * else.
 */

const PRIVATE_V4 = [
    /^10\./,
    /^192\.168\./,
    /^127\./,
    // 172.16.0.0 through 172.31.255.255, which is the private range; 172.32+ is not.
    /^172\.(1[6-9]|2\d|3[01])\./,
    // Link local, what a machine gives itself when nothing hands it an address.
    /^169\.254\./,
];

export function isLocalAddress(address: string | undefined): boolean {
    if (!address) {
        return false;
    }
    // An ipv4 client on a dual stack socket arrives written as ::ffff:10.0.0.5.
    const plain = address.replace(/^::ffff:/i, "").toLowerCase();
    if (PRIVATE_V4.some(range => range.test(plain))) {
        return true;
    }
    if (plain === "::1" || plain === "::") {
        return true;
    }
    // fc00::/7 is the ipv6 equivalent of a private range, fe80::/10 is link local.
    return /^f[cd][0-9a-f]{2}:/.test(plain) || /^fe[89ab][0-9a-f]:/.test(plain);
}
