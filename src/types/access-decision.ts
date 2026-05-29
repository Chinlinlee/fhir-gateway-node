/** Aligns with Java AccessDecision.canAccess(). */
export type AccessDecision = {
    canAccess: () => boolean;
};

export const accessGranted = (): AccessDecision => ({
    canAccess: () => true,
});

export const accessDenied = (): AccessDecision => ({
    canAccess: () => false,
});
