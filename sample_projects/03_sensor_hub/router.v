module router (
    input wire clk,
    input wire rst,
    input wire packet_valid,
    input wire [15:0] packet_data,
    input wire route_uart,
    input wire route_spi,
    input wire serial_rx,
    input wire spi_miso,
    output wire serial_tx,
    output wire spi_sclk,
    output wire spi_mosi,
    output wire spi_cs_n,
    output wire uart_busy,
    output wire spi_busy,
    output wire [7:0] status_code
);
    wire [7:0] uart_status;
    wire [7:0] spi_status;

    uart_bridge u_uart_bridge (
        .clk(clk),
        .rst(rst),
        .enable(route_uart & packet_valid),
        .data_in(packet_data[7:0]),
        .serial_rx(serial_rx),
        .serial_tx(serial_tx),
        .busy(uart_busy),
        .status(uart_status)
    );

    spi_bridge u_spi_bridge (
        .clk(clk),
        .rst(rst),
        .enable(route_spi & packet_valid),
        .data_in(packet_data[7:0]),
        .spi_miso(spi_miso),
        .spi_sclk(spi_sclk),
        .spi_mosi(spi_mosi),
        .spi_cs_n(spi_cs_n),
        .busy(spi_busy),
        .status(spi_status)
    );

    priority_mux u_status_mux (
        .sel(route_uart),
        .a(uart_status),
        .b(spi_status),
        .y(status_code)
    );
endmodule
