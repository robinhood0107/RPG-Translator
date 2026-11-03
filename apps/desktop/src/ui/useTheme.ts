import { useEffect, useState } from "react";

export type Theme = "light" | "dark";
export const themeStorageKey = "rpg-translator.theme";

// 포털로 표시하는 메뉴와 대화상자에도 같은 색상을 적용하도록 문서 루트에 테마를 둡니다.
export function useTheme() {
  const [theme, setTheme] = useState<Theme>(() =>
    localStorage.getItem(themeStorageKey) === "dark" ? "dark" : "light",
  );

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem(themeStorageKey, theme);
  }, [theme]);

  return [theme, () => setTheme((current) => current === "dark" ? "light" : "dark")] as const;
}
