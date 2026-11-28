"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

type Item = { href: string; label: string };

const ITEMS: Item[] = [
  { href: "/", label: "Assistente" },
  { href: "/nuova", label: "Nuova riunione" },
  { href: "/richieste", label: "Le mie richieste" },
];
const ADMIN_ITEM: Item = { href: "/admin", label: "Amministrazione" };

function isActive(pathname: string, href: string): boolean {
  return href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
}

export function AppNav({ isAdmin }: { isAdmin: boolean }) {
  const pathname = usePathname();
  const items = isAdmin ? [...ITEMS, ADMIN_ITEM] : ITEMS;
  return (
    <nav aria-label="Principale" className="flex flex-wrap gap-1">
      {items.map((item) => {
        const active = isActive(pathname, item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={
              active
                ? "rounded-lg bg-[#EAF0FC] px-3.5 py-2.5 text-[15px] font-semibold text-[#1F4FC7] no-underline"
                : "rounded-lg px-3.5 py-2.5 text-[15px] text-[#3D434D] no-underline hover:bg-[#F5F6F8] hover:text-[#14161A]"
            }
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
