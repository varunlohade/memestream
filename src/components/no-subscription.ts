/** useSyncExternalStore's `subscribe` for browser-only values that never notify (sessionStorage, hostname, canvas textures). */
export const noSubscription = () => () => {};
