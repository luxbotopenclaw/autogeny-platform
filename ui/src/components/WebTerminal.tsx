import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

interface WebTerminalProps {
  companyId: string;
  onClose: () => void;
}

export function WebTerminal({ companyId, onClose }: WebTerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: "monospace",
      theme: {
        background: "#0d0d0d",
        foreground: "#d4d4d4",
      },
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(containerRef.current);
    fitAddon.fit();

    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${proto}//${window.location.host}/api/companies/${companyId}/terminal/ws`;
    const ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      term.writeln("\x1b[32mConnected. Run `claude auth login` to authenticate.\x1b[0m\r\n");
    };

    ws.onmessage = (e) => {
      term.write(typeof e.data === "string" ? e.data : "");
    };

    ws.onclose = () => {
      term.writeln("\r\n\x1b[33mConnection closed.\x1b[0m");
      onClose();
    };

    ws.onerror = () => {
      term.writeln("\r\n\x1b[31mConnection error.\x1b[0m");
    };

    term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    });

    term.onResize(({ cols, rows }) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "resize", cols, rows }));
      }
    });

    const ro = new ResizeObserver(() => {
      fitAddon.fit();
    });

    if (containerRef.current) {
      ro.observe(containerRef.current);
    }

    return () => {
      ws.close();
      term.dispose();
      ro.disconnect();
    };
  }, [companyId, onClose]);

  return (
    <div
      ref={containerRef}
      className="h-[300px] w-full rounded-md overflow-hidden border border-border bg-[#0d0d0d]"
    />
  );
}
