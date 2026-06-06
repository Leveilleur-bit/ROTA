// Persistance locale (navigateur) — même API que celle utilisée par le composant.
// Les données restent sur cet appareil/navigateur (tier "individuel").
export const storage = {
  async get(key) {
    try {
      const v = localStorage.getItem(key);
      return v === null ? null : { key, value: v };
    } catch (e) {
      return null;
    }
  },
  async set(key, value) {
    try { localStorage.setItem(key, value); } catch (e) {}
    return { key, value };
  },
  async delete(key) {
    try { localStorage.removeItem(key); } catch (e) {}
    return { key, deleted: true };
  },
};
