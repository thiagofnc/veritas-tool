# UART Link Sample

This sample models a simple point-to-point UART connection between two endpoints.

- `uart_baud_gen.v`: shared baud tick generator used by each endpoint
- `uart_tx.v`: byte-oriented UART transmitter with start/data/stop framing
- `uart_rx.v`: byte-oriented UART receiver with stop-bit frame error detection
- `uart_endpoint.v`: one UART node with a local TX, RX, and baud generator
- `uart_link_top.v`: two endpoints wired back-to-back for bidirectional traffic

The project also includes managed testbenches under `testbenches/`:

- `tb_uart_link_smoke.sv`: sends bytes both directions through `uart_link_top`
- `tb_uart_rx_frame_error.sv`: injects a bad stop bit into `uart_rx` and verifies recovery
