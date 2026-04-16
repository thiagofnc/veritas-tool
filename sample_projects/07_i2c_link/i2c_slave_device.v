module i2c_slave_device #(
    parameter [6:0] ADDRESS = 7'h42
) (
    input wire clk,
    input wire rst,
    input wire scl,
    input wire sda,
    output reg sda_drive_low,
    output reg [7:0] rx_data,
    output reg rx_valid
);
    localparam [2:0] STATE_IDLE = 3'd0;
    localparam [2:0] STATE_ADDRESS = 3'd1;
    localparam [2:0] STATE_ADDR_ACK = 3'd2;
    localparam [2:0] STATE_DATA = 3'd3;
    localparam [2:0] STATE_DATA_ACK = 3'd4;

    reg [2:0] state;
    reg scl_prev;
    reg sda_prev;
    reg [7:0] shift_reg;
    reg [2:0] bit_index;
    reg address_match;

    wire scl_rise = ~scl_prev & scl;
    wire scl_fall = scl_prev & ~scl;
    wire start_cond = sda_prev & ~sda & scl;
    wire stop_cond = ~sda_prev & sda & scl;

    always @(posedge clk or posedge rst) begin
        if (rst) begin
            state <= STATE_IDLE;
            scl_prev <= 1'b1;
            sda_prev <= 1'b1;
            shift_reg <= 8'd0;
            bit_index <= 3'd7;
            address_match <= 1'b0;
            sda_drive_low <= 1'b0;
            rx_data <= 8'd0;
            rx_valid <= 1'b0;
        end else begin
            rx_valid <= 1'b0;

            if (start_cond) begin
                state <= STATE_ADDRESS;
                bit_index <= 3'd7;
                sda_drive_low <= 1'b0;
                address_match <= 1'b0;
            end else if (stop_cond) begin
                state <= STATE_IDLE;
                sda_drive_low <= 1'b0;
                address_match <= 1'b0;
            end else begin
                case (state)
                    STATE_IDLE: begin
                        sda_drive_low <= 1'b0;
                        bit_index <= 3'd7;
                    end

                    STATE_ADDRESS: begin
                        if (scl_rise) begin
                            shift_reg[bit_index] <= sda;
                            if (bit_index == 3'd0) begin
                                state <= STATE_ADDR_ACK;
                            end else begin
                                bit_index <= bit_index - 3'd1;
                            end
                        end
                    end

                    STATE_ADDR_ACK: begin
                        if (scl_fall && !sda_drive_low) begin
                            address_match <= (shift_reg[7:1] == ADDRESS) && (shift_reg[0] == 1'b0);
                            if ((shift_reg[7:1] == ADDRESS) && (shift_reg[0] == 1'b0)) begin
                                sda_drive_low <= 1'b1;
                            end else begin
                                state <= STATE_IDLE;
                            end
                        end else if (scl_fall && sda_drive_low) begin
                            sda_drive_low <= 1'b0;
                            bit_index <= 3'd7;
                            state <= STATE_DATA;
                        end
                    end

                    STATE_DATA: begin
                        if (scl_rise) begin
                            shift_reg[bit_index] <= sda;
                            if (bit_index == 3'd0) begin
                                state <= STATE_DATA_ACK;
                            end else begin
                                bit_index <= bit_index - 3'd1;
                            end
                        end
                    end

                    STATE_DATA_ACK: begin
                        if (scl_fall && !sda_drive_low) begin
                            sda_drive_low <= 1'b1;
                            rx_data <= shift_reg;
                            rx_valid <= 1'b1;
                        end else if (scl_fall && sda_drive_low) begin
                            sda_drive_low <= 1'b0;
                            state <= STATE_IDLE;
                        end
                    end

                    default: begin
                        state <= STATE_IDLE;
                        sda_drive_low <= 1'b0;
                    end
                endcase
            end

            scl_prev <= scl;
            sda_prev <= sda;
        end
    end
endmodule
