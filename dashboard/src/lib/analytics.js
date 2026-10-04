// Product analytics were removed from this fork: the panel phones home to
// nobody. `track` stays as a no-op so call sites need no special casing.
export function track() {}
