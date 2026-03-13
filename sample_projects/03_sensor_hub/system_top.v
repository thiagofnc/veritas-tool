module system_top (
    input wire clk,
    input wire rst,
    input wire start,
    input wire serial_rx,
    input wire spi_miso,
    output wire serial_tx,
    output wire spi_sclk,
    output wire spi_mosi,
    output wire spi_cs_n,
    output wire system_busy
);
    wire sample_valid;
    wire [11:0] sample_data;
    wire filt_valid;
    wire [11:0] filt_data;
    wire packet_valid;
    wire [15:0] packet_data;
    wire route_uart;
    wire route_spi;
    wire uart_busy;
    wire spi_busy;
    wire [7:0] status_code;

    scheduler u_scheduler (
        .clk(clk),
        .rst(rst),
        .start(start),
        .route_uart(route_uart),
        .route_spi(route_spi),
        .busy(system_busy)
    );

    sensor_frontend u_sensor_frontend (
        .clk(clk),
        .rst(rst),
        .enable(start),
        .sample_valid(sample_valid),
        .sample_data(sample_data),
        .filt_valid(filt_valid),
        .filt_data(filt_data)
    );

    packetizer u_packetizer (
        .clk(clk),
        .rst(rst),
        .sample_valid(filt_valid),
        .sample_data(filt_data),
        .packet_valid(packet_valid),
        .packet_data(packet_data)
    );

    router u_router (
        .clk(clk),
        .rst(rst),
        .packet_valid(packet_valid),
        .packet_data(packet_data),
        .route_uart(route_uart),
        .route_spi(route_spi),
        .serial_rx(serial_rx),
        .spi_miso(spi_miso),
        .serial_tx(serial_tx),
        .spi_sclk(spi_sclk),
        .spi_mosi(spi_mosi),
        .spi_cs_n(spi_cs_n),
        .uart_busy(uart_busy),
        .spi_busy(spi_busy),
        .status_code(status_code)
    );

    status_block u_status_block (
        .clk(clk),
        .rst(rst),
        .uart_busy(uart_busy),
        .spi_busy(spi_busy),
        .packet_valid(packet_valid),
        .status_code(status_code)
    );
endmodule
