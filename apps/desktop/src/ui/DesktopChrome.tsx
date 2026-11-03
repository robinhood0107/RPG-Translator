import { Moon, Sun } from "lucide-react";
import type { MouseEvent } from "react";
import type { Theme } from "./useTheme";

type Menu = { label: string; onClick: (event: MouseEvent<HTMLButtonElement>) => void };

// 상단 메뉴는 기존 작업 함수를 전달받아 화면 배치와 실제 명령 처리를 분리합니다.
export function DesktopChrome({ title, menus, theme, onToggleTheme, korean }: {
  title: string;
  menus: Menu[];
  theme: Theme;
  onToggleTheme: () => void;
  korean: boolean;
}) {
  return (
    <header className="desktop-chrome">
      <nav role="menubar" aria-label={korean ? "프로그램 메뉴" : "Application menu"}>
        {menus.map((menu) => <button key={menu.label} role="menuitem" aria-haspopup="menu" type="button" onClick={menu.onClick}>{menu.label}</button>)}
      </nav>
      <span className="document-title">{title}</span>
      <button
        className="theme-toggle"
        type="button"
        role="switch"
        aria-checked={theme === "dark"}
        aria-label={korean ? "다크 모드" : "Dark mode"}
        onClick={onToggleTheme}
      >
        {theme === "dark" ? <Moon size={14} /> : <Sun size={14} />}
        {theme === "dark" ? (korean ? "다크" : "Dark") : (korean ? "라이트" : "Light")}
      </button>
    </header>
  );
}
