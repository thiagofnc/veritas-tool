module i2c_slave_device #(
    parameter [6:0] ADDRESS = 7'h42
) (
    input  wire       clk,
    input  wire       rst,
    input  wire       scl,
    input  wire       sda,
    output reg        sda_drive_low,
    output reg [7:0]  rx_data,
    output reg        rx_valid
);
    localparam [2:0] STATE_IDLE     = 3'd0;
    localparam [2:0] STATE_ADDRESS  = 3'd1;
    localparam [2:0] STATE_ADDR_ACK = 3'd2;
    localparam [2:0] STATE_DATA     = 3'd3;
    localparam [2:0] STATE_DATA_ACK = 3'd4;

    reg [2:0] state;
    reg scl_prev;
    reg sda_prev;
    reg [7:0] shift_reg;
    reg [2:0] bit_index;
    reg       ack_active;

    wire scl_rise   = ~scl_prev &  scl;
    wire scl_fall   =  scl_prev & ~scl;
    wire start_cond =  sda_prev & ~sda & scl;
    wire stop_cond  = ~sda_prev &  sda & scl;

    // rx_valid is a "sticky" pulse: once a byte is received, hold rx_valid high
    // until the next START, reset, or explicit STOP. This makes it easy for
    // simple testbenches to observe the received byte.

    always @(posedge clk or posedge rst) begin
        if (rst) begin
            state <= STATE_IDLE;
            scl_prev <= 1'b1;
            sda_prev <= 1'b1;
            shift_reg <= 8'd0;
            bit_index <= 3'd7;
            sda_drive_low <= 1'b0;
            rx_data <= 8'd0;
            rx_valid <= 1'b0;
            ack_active <= 1'b0;
        end else begin
            if (start_cond) begin
                rx_valid <= 1'b0;
            end

            if (start_cond) begin
                state <= STATE_ADDRESS;
                bit_index <= 3'd7;
                sda_drive_low <= 1'b0;
                ack_active <= 1'b0;
            end else if (stop_cond) begin
                state <= STATE_IDLE;
                sda_drive_low <= 1'b0;
                ack_active <= 1'b0;
            end else begin
                case (state)
                    STATE_IDLE: begin
                        sda_drive_low <= 1'b0;
                        bit_index <= 3'd7;
                        ack_active <= 1'b0;
                    end

                    STATE_ADDRESS: begin
                        if (scl_rise) begin
                            shift_reg[bit_index] <= sda;
                            if (bit_index == 3'd0) begin
                                state <= STATE_ADDR_ACK;
                                ack_active <= 1'b0;
                            end else begin
                                bit_index <= bit_index - 3'd1;
                            end
                        end
                    end

                    STATE_ADDR_ACK: begin
                        if (!ack_active && scl_fall) begin
                            if ((shift_reg[7:1] == ADDRESS) && (shift_reg[0] == 1'b0)) begin
                                sda_drive_low <= 1'b1;
                                ack_active <= 1'b1;
                            end else begin
                                sda_drive_low <= 1'b0;
                                state <= STATE_IDLE;
                            end
                        end else if (ack_active && scl_fall) begin
                            sda_drive_low <= 1'b0;
                            ack_active <= 1'b0;
                            bit_index <= 3'd7;
                            state <= STATE_DATA;
                        end
                    end

                    STATE_DATA: begin
                        if (scl_rise) begin
                            shift_reg[bit_index] <= sda;
                            if (bit_index == 3'd0) begin
                                state <= STATE_DATA_ACK;
                                ack_active <= 1'b0;
                            end else begin
                                bit_index <= bit_index - 3'd1;
                            end
                        end
                    end

                    STATE_DATA_ACK: begin
                        if (!ack_active && scl_fall) begin
                            // Prepare ACK and latch received byte
                            sda_drive_low <= 1'b1;
                            ack_active <= 1'b1;
                            rx_data <= shift_reg;
                            rx_valid <= 1'b1;
                        end else if (ack_active && scl_fall) begin
                            sda_drive_low <= 1'b0;
                            ack_active <= 1'b0;
                            state <= STATE_IDLE;
                        end
                    end

                    default: begin
                        state <= STATE_IDLE;
                        sda_drive_low <= 1'b0;
                        ack_active <= 1'b0;
                    end
                endcase
            end

            scl_prev <= scl;
            sda_prev <= sda;
        end
    end
endmodule
