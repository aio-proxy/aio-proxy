//! Whether this user owns the serving end of a connection. Another local account can bind the
//! proxy's port while it is down and answer `/health`; the desktop token goes only over a
//! connection whose accepted socket belongs to a process of this user. Fails closed on any API
//! failure.

use std::io;
use std::mem::offset_of;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, TcpStream};
use std::ptr::null_mut;
use std::thread;
use std::time::{Duration, Instant};

use windows_sys::Win32::Foundation::{ERROR_INSUFFICIENT_BUFFER, NO_ERROR};
use windows_sys::Win32::NetworkManagement::IpHelper::{
    GetExtendedTcpTable, MIB_TCP6ROW_OWNER_PID, MIB_TCP6TABLE_OWNER_PID, MIB_TCPROW_OWNER_PID, MIB_TCPTABLE_OWNER_PID,
    TCP_TABLE_OWNER_PID_ALL,
};
use windows_sys::Win32::Networking::WinSock::{AF_INET, AF_INET6};

use super::process::{current_user_sid, process_user_sid};
use crate::platform::tcp_row::{TcpRow, serving_pid};

const RETRY: Duration = Duration::from_millis(25);

/// The port sits in the low 16 bits of the DWORD, in network byte order as stored.
fn port(dword: u32) -> u16 {
    let [hi, lo, ..] = dword.to_ne_bytes();
    u16::from_be_bytes([hi, lo])
}

/// Every TCP connection and listener of the family, with its owning process.
pub fn tcp_rows(v6: bool) -> io::Result<Vec<TcpRow>> {
    let family = u32::from(if v6 { AF_INET6 } else { AF_INET });
    let mut buffer: Vec<u64> = Vec::new();
    let mut size = 0u32;
    // The table can grow between the sizing call and the read; each retry uses the new size.
    for _ in 0..4 {
        let table = if buffer.is_empty() { null_mut() } else { buffer.as_mut_ptr().cast() };
        // SAFETY: `table` is null with `size` 0, or a writable buffer of `size` bytes.
        let status = unsafe { GetExtendedTcpTable(table, &mut size, 0, family, TCP_TABLE_OWNER_PID_ALL, 0) };
        if status == NO_ERROR && !buffer.is_empty() {
            let bytes = (size as usize).min(buffer.len() * 8);
            // SAFETY: the call filled the first `bytes` bytes of `buffer`.
            let table = unsafe { std::slice::from_raw_parts(buffer.as_ptr().cast::<u8>(), bytes) };
            return Ok(if v6 { v6_rows(table) } else { v4_rows(table) });
        }
        if status != NO_ERROR && status != ERROR_INSUFFICIENT_BUFFER {
            return Err(io::Error::from_raw_os_error(status as i32));
        }
        buffer = vec![0u64; (size as usize).div_ceil(8).max(1)];
        size = (buffer.len() * 8) as u32;
    }
    Err(io::Error::other("the TCP table kept growing"))
}

/// The rows a table holds; a count that overruns the bytes returned yields no rows.
fn table_rows<R: Copy>(table: &[u8], first_row: usize) -> Vec<R> {
    let Some(count) = table.get(..4).map(|n| u32::from_ne_bytes(n.try_into().unwrap()) as usize) else {
        return Vec::new();
    };
    let fits =
        count.checked_mul(size_of::<R>()).and_then(|n| n.checked_add(first_row)).is_some_and(|end| end <= table.len());
    if !fits {
        return Vec::new();
    }
    (0..count)
        // SAFETY: row `i` lies inside `table` (checked above); unaligned reads need no alignment.
        .map(|i| unsafe { table.as_ptr().add(first_row + i * size_of::<R>()).cast::<R>().read_unaligned() })
        .collect()
}

fn v4_rows(table: &[u8]) -> Vec<TcpRow> {
    let addr = |a: u32, p: u32| SocketAddr::new(IpAddr::V4(Ipv4Addr::from(a.to_ne_bytes())), port(p));
    table_rows::<MIB_TCPROW_OWNER_PID>(table, offset_of!(MIB_TCPTABLE_OWNER_PID, table))
        .into_iter()
        .map(|r| TcpRow {
            local: addr(r.dwLocalAddr, r.dwLocalPort),
            remote: addr(r.dwRemoteAddr, r.dwRemotePort),
            pid: r.dwOwningPid,
        })
        .collect()
}

fn v6_rows(table: &[u8]) -> Vec<TcpRow> {
    let addr = |a: [u8; 16], p: u32| SocketAddr::new(IpAddr::V6(Ipv6Addr::from(a)), port(p));
    table_rows::<MIB_TCP6ROW_OWNER_PID>(table, offset_of!(MIB_TCP6TABLE_OWNER_PID, table))
        .into_iter()
        .map(|r| TcpRow {
            local: addr(r.ucLocalAddr, r.dwLocalPort),
            remote: addr(r.ucRemoteAddr, r.dwRemotePort),
            pid: r.dwOwningPid,
        })
        .collect()
}

/// Whether this user's process holds the other end of `stream`. The server may not have accepted yet,
/// so the table is re-read every 25 ms until `deadline`; any failure counts as not ours.
pub fn peer_owned_by_this_user(stream: &TcpStream, deadline: Instant) -> bool {
    let (Ok(client), Ok(server)) = (stream.local_addr(), stream.peer_addr()) else { return false };
    let ours = current_user_sid();
    if ours.is_empty() {
        return false;
    }
    loop {
        if let Ok(rows) = tcp_rows(server.is_ipv6())
            && let Some(pid) = serving_pid(&rows, server, client)
            && process_user_sid(pid).is_some_and(|sid| sid == ours)
        {
            return true;
        }
        if Instant::now() + RETRY >= deadline {
            return false;
        }
        thread::sleep(RETRY);
    }
}

#[cfg(test)]
mod tests;
